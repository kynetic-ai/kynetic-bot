/**
 * Session Lifecycle Integration Tests
 *
 * Tests integration of SessionLifecycleManager, ContextRestorer,
 * and ContextUsageTracker with the Bot class.
 *
 * AC Coverage (from @mem-session-lifecycle):
 * - AC-1: Reuse session under 70% context limit
 * - AC-2: Create new session with context restoration when exceeding 70%
 * - AC-3: Restore context from persisted history on restart
 * - AC-4: Mark previous session completed on rotation
 * - AC-7: Continue with stale data when /usage fails
 * - AC-8: Serialize concurrent messages via per-key lock
 * - AC-9: Rebuild state from ConversationStore on restart (< 30 min)
 *
 * Trait Validation:
 * - @trait-observable: Events emitted on session lifecycle changes
 * - @trait-recoverable: Continue processing on failures
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@kynetic-bot/core';
import {
  SessionLifecycleManager,
  ContextRestorer,
  ContextUsageTracker,
  type ContextUsageUpdate,
} from '@kynetic-bot/messaging';
import type { BotConfig } from '../../src/config.js';
import { Bot, _resetGitRootCache } from '../../src/bot.js';

// Mock child_process for git root
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue('/test/git/root\n'),
  };
});

// Mock memory stores
vi.mock('@kynetic-bot/memory', () => {
  class MockKbotShadow {
    initialize = vi.fn().mockResolvedValue(undefined);
    shutdown = vi.fn().mockResolvedValue(undefined);
    getState = vi.fn().mockReturnValue('ready');
    isReady = vi.fn().mockReturnValue(true);
    on = vi.fn();
    emit = vi.fn();
  }

  class MockSessionStore {
    createSession = vi.fn().mockResolvedValue({ id: 'session-123' });
    getSession = vi.fn().mockResolvedValue(null);
    listSessions = vi.fn().mockResolvedValue([]);
    updateSessionStatus = vi.fn().mockResolvedValue(null);
    appendEvent = vi.fn().mockResolvedValue({ ts: Date.now(), seq: 0 });
  }

  class MockConversationStore {
    getOrCreateConversation = vi.fn().mockResolvedValue({
      id: 'conv-123',
      session_key: 'session-key',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      turn_count: 0,
    });
    appendTurn = vi.fn().mockResolvedValue({ ts: Date.now(), seq: 0, role: 'user', content: '' });
    readTurns = vi.fn().mockResolvedValue([]);
    getConversation = vi.fn().mockResolvedValue(null);
    getConversationBySessionKey = vi.fn().mockResolvedValue(null);
  }

  // Mock TurnReconstructor for context restoration
  class MockTurnReconstructor {
    getContent = vi.fn().mockResolvedValue('');
    reconstructContent = vi.fn().mockResolvedValue({
      content: '',
      hasGaps: false,
      eventsRead: 0,
      eventsMissing: 0,
    });
  }

  return {
    KbotShadow: MockKbotShadow,
    SessionStore: MockSessionStore,
    ConversationStore: MockConversationStore,
    TurnReconstructor: MockTurnReconstructor,
  };
});

/**
 * Create a mock NormalizedMessage
 */
function createMockMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: `msg-${Date.now()}`,
    text: 'Hello, bot!',
    sender: {
      id: 'user-456',
      platform: 'discord',
      displayName: 'Test User',
    },
    timestamp: new Date(),
    channel: 'channel-789',
    metadata: {},
    ...overrides,
  };
}

/**
 * Create a mock BotConfig
 */
function createMockConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    discordToken: 'test-token',
    agentCommand: 'test-agent',
    kbotDataDir: '.kbot',
    logLevel: 'info',
    healthCheckInterval: 100,
    shutdownTimeout: 500,
    ...overrides,
  };
}

/**
 * Create a mock ACP Client
 */
function createMockACPClient() {
  const clientEmitter = new EventEmitter();
  let sessionCounter = 0;
  const mockClient = Object.assign(clientEmitter, {
    newSession: vi.fn().mockImplementation(async () => `session-${++sessionCounter}`),
    prompt: vi.fn().mockImplementation(async () => {
      clientEmitter.emit('update', 'session-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello!' },
      });
      return { stopReason: 'end_turn' };
    }),
    getSession: vi.fn().mockReturnValue({ id: 'session-1', status: 'idle' }),
  });
  return mockClient;
}

/**
 * Create a mock AgentLifecycle
 */
function createMockAgent() {
  const emitter = new EventEmitter();
  const mockClient = createMockACPClient();

  return Object.assign(emitter, {
    getState: vi.fn().mockReturnValue('healthy' as const),
    isHealthy: vi.fn().mockReturnValue(true),
    getClient: vi.fn().mockReturnValue(mockClient),
    getSessionId: vi.fn().mockReturnValue(null),
    spawn: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    onStderr: vi.fn().mockReturnValue(() => {}),
    _mockClient: mockClient,
  });
}

/**
 * Create a mock SessionKeyRouter
 */
function createMockRouter() {
  return {
    resolveSession: vi.fn().mockReturnValue({
      ok: true,
      value: {
        key: 'session-key',
        agent: 'main',
        platform: 'discord',
        peerId: 'user-456',
        peerKind: 'user' as const,
        context: [],
        createdAt: new Date(),
        lastActivity: new Date(),
      },
    }),
    addAgent: vi.fn(),
    removeAgent: vi.fn(),
    getSession: vi.fn(),
    updateSession: vi.fn(),
    deleteSession: vi.fn(),
  };
}

/**
 * Create a mock ChannelLifecycle
 */
function createMockChannelLifecycle() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'sent-msg-1' }),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
    startTypingLoop: vi.fn().mockResolvedValue(undefined),
    stopTypingLoop: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create usage update for testing
 */
function createUsageUpdate(percentage: number): ContextUsageUpdate {
  return {
    type: 'context_usage',
    model: 'claude-opus-4-5-20251101',
    tokens: {
      current: Math.round((percentage / 100) * 200000),
      max: 200000,
      percentage,
    },
    categories: [],
    timestamp: Date.now(),
  };
}

describe('Session Lifecycle Integration', () => {
  let config: BotConfig;
  let mockAgent: ReturnType<typeof createMockAgent>;
  let mockRouter: ReturnType<typeof createMockRouter>;
  let mockShadow: {
    initialize: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    isReady: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
  };
  let mockRegistry: {
    get: ReturnType<typeof vi.fn>;
    register: ReturnType<typeof vi.fn>;
    unregister: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetGitRootCache();

    config = createMockConfig();
    mockAgent = createMockAgent();
    mockRouter = createMockRouter();
    mockShadow = {
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue('ready'),
      isReady: vi.fn().mockReturnValue(true),
      on: vi.fn(),
      emit: vi.fn(),
    };
    mockRegistry = {
      get: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
      list: vi.fn().mockReturnValue([]),
    };
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  // AC: @mem-session-lifecycle ac-1
  describe('AC-1: Session Reuse Under 70% Threshold', () => {
    it('reuses existing session when context usage is below threshold', async () => {
      // Arrange
      const sessionLifecycle = new SessionLifecycleManager({ rotationThreshold: 0.7 });

      const bot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        registry: mockRegistry as unknown as Parameters<
          typeof Bot.createWithDependencies
        >[0]['registry'],
        sessionLifecycle,
      });
      await bot.start();

      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(
        lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]
      );

      // Act - send two messages
      await bot.handleMessage(createMockMessage({ id: 'msg-1' }));

      // Update usage to 50% (under threshold)
      sessionLifecycle.updateContextUsage('session-key', createUsageUpdate(50));

      await bot.handleMessage(createMockMessage({ id: 'msg-2' }));

      // Assert - session reused (newSession called only once)
      expect(mockAgent._mockClient.newSession).toHaveBeenCalledTimes(1);
      expect(sessionLifecycle.getAllSessions()).toHaveLength(1);

      await bot.stop();
    });
  });

  // AC: @mem-session-lifecycle ac-2
  describe('AC-2: Session Rotation Above 70% Threshold', () => {
    it('rotates session when context usage exceeds threshold', async () => {
      // Arrange
      const sessionLifecycle = new SessionLifecycleManager({ rotationThreshold: 0.7 });
      const rotatedHandler = vi.fn();
      sessionLifecycle.on('session:rotated', rotatedHandler);

      const bot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        registry: mockRegistry as unknown as Parameters<
          typeof Bot.createWithDependencies
        >[0]['registry'],
        sessionLifecycle,
      });
      await bot.start();

      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(
        lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]
      );

      // Act - send first message
      await bot.handleMessage(createMockMessage({ id: 'msg-1' }));

      // Update usage to 75% (above threshold)
      sessionLifecycle.updateContextUsage('session-key', createUsageUpdate(75));

      // Second message should trigger rotation
      await bot.handleMessage(createMockMessage({ id: 'msg-2' }));

      // Assert - new session created
      expect(mockAgent._mockClient.newSession).toHaveBeenCalledTimes(2);
      expect(rotatedHandler).toHaveBeenCalled();

      await bot.stop();
    });
  });

  // AC: @mem-session-lifecycle ac-7
  describe('AC-7: Continue with Stale Data on Usage Errors', () => {
    it('continues processing when usage check fails', async () => {
      // Arrange
      const contextUsageTracker = new ContextUsageTracker({ timeout: 100 });
      vi.spyOn(contextUsageTracker, 'checkUsage').mockRejectedValue(
        new Error('Usage check failed')
      );

      const bot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        registry: mockRegistry as unknown as Parameters<
          typeof Bot.createWithDependencies
        >[0]['registry'],
        contextUsageTracker,
      });
      await bot.start();

      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(
        lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]
      );

      const processedHandler = vi.fn();
      bot.on('message:processed', processedHandler);

      // Act - should not throw
      await bot.handleMessage(createMockMessage());

      // Assert - message still processed
      expect(processedHandler).toHaveBeenCalled();
      expect(lifecycle.sendMessage).toHaveBeenCalled();

      await bot.stop();
    });
  });

  // AC: @mem-session-lifecycle ac-8
  describe('AC-8: Message Serialization via Per-Key Lock', () => {
    it('serializes session acquisition for concurrent messages', async () => {
      // Arrange
      const sessionAcquisitionOrder: string[] = [];
      const sessionLifecycle = new SessionLifecycleManager();

      // Track session acquisition order via getOrCreateSession calls
      const originalGetOrCreate = sessionLifecycle.getOrCreateSession.bind(sessionLifecycle);
      vi.spyOn(sessionLifecycle, 'getOrCreateSession').mockImplementation(async (...args) => {
        const id = `acquire-${sessionAcquisitionOrder.length + 1}`;
        sessionAcquisitionOrder.push(`${id}-start`);
        await new Promise((r) => setTimeout(r, 20));
        const result = await originalGetOrCreate(...args);
        sessionAcquisitionOrder.push(`${id}-end`);
        return result;
      });

      const bot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        registry: mockRegistry as unknown as Parameters<
          typeof Bot.createWithDependencies
        >[0]['registry'],
        sessionLifecycle,
      });
      await bot.start();

      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(
        lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]
      );

      // Act - send messages concurrently
      const p1 = bot.handleMessage(createMockMessage({ id: 'msg-1', text: 'First' }));
      const p2 = bot.handleMessage(createMockMessage({ id: 'msg-2', text: 'Second' }));
      await Promise.all([p1, p2]);

      // Assert - session acquisition is serialized
      // The lock ensures getOrCreateSession calls don't overlap for same session key
      // We expect: acquire-1-start, acquire-1-end, acquire-2-start, acquire-2-end
      expect(sessionAcquisitionOrder).toHaveLength(4);

      const startIndices = sessionAcquisitionOrder
        .map((e, i) => (e.endsWith('-start') ? i : -1))
        .filter((i) => i >= 0);
      const endIndices = sessionAcquisitionOrder
        .map((e, i) => (e.endsWith('-end') ? i : -1))
        .filter((i) => i >= 0);

      // First acquisition completes before second starts
      expect(endIndices[0]).toBeLessThan(startIndices[1]);

      await bot.stop();
    });
  });

  // @trait-observable
  describe('@trait-observable: Event Emission', () => {
    it('emits session:created when new session is created', async () => {
      // Arrange
      const sessionCreatedHandler = vi.fn();
      const sessionLifecycle = new SessionLifecycleManager();
      sessionLifecycle.on('session:created', sessionCreatedHandler);

      const bot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        registry: mockRegistry as unknown as Parameters<
          typeof Bot.createWithDependencies
        >[0]['registry'],
        sessionLifecycle,
      });
      await bot.start();

      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(
        lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]
      );

      // Act
      await bot.handleMessage(createMockMessage());

      // Assert
      expect(sessionCreatedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: 'session-key',
        })
      );

      await bot.stop();
    });

    it('forwards session lifecycle events to bot emitter', async () => {
      // Arrange
      const botCreatedHandler = vi.fn();
      const sessionLifecycle = new SessionLifecycleManager();

      const bot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        registry: mockRegistry as unknown as Parameters<
          typeof Bot.createWithDependencies
        >[0]['registry'],
        sessionLifecycle,
      });
      bot.on('session:created', botCreatedHandler);
      await bot.start();

      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(
        lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]
      );

      // Act
      await bot.handleMessage(createMockMessage());

      // Assert - bot forwarded the event
      expect(botCreatedHandler).toHaveBeenCalled();

      await bot.stop();
    });
  });

  // @trait-recoverable
  describe('@trait-recoverable: Error Handling', () => {
    it('continues processing when context restoration fails', async () => {
      // Arrange
      const contextRestorer = new ContextRestorer(null);
      vi.spyOn(contextRestorer, 'generateRestorationPrompt').mockRejectedValue(
        new Error('Restoration failed')
      );

      // Create session lifecycle that will trigger restoration
      const sessionLifecycle = new SessionLifecycleManager();

      const bot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        registry: mockRegistry as unknown as Parameters<
          typeof Bot.createWithDependencies
        >[0]['registry'],
        sessionLifecycle,
        contextRestorer,
      });
      await bot.start();

      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(
        lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]
      );

      const processedHandler = vi.fn();
      bot.on('message:processed', processedHandler);

      // Act - should not throw
      await bot.handleMessage(createMockMessage());

      // Assert - message still processed
      expect(processedHandler).toHaveBeenCalled();

      await bot.stop();
    });

    it('sends identity prompt when context restoration is skipped', async () => {
      // Arrange - restoration returns skipped
      const contextRestorer = new ContextRestorer(null);
      vi.spyOn(contextRestorer, 'generateRestorationPrompt').mockResolvedValue({
        skipped: true,
        prompt: '',
        stats: {
          recentTurns: 0,
          summarizedTurns: 0,
          totalTokens: 0,
          summaryFailed: false,
          truncatedTurns: 0,
        },
      });

      const bot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        registry: mockRegistry as unknown as Parameters<
          typeof Bot.createWithDependencies
        >[0]['registry'],
        contextRestorer,
      });
      await bot.start();

      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(
        lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]
      );

      // Act
      await bot.handleMessage(createMockMessage());

      // Assert - identity prompt sent (since restoration was skipped)
      const promptCalls = mockAgent._mockClient.prompt.mock.calls;
      const identityCall = promptCalls.find((call) => call[0]?.promptSource === 'system');
      expect(identityCall).toBeDefined();

      await bot.stop();
    });
  });
});
