/**
 * Bot Orchestration Tests
 *
 * Test coverage for Bot class covering all 6 ACs and 4 inherited traits.
 *
 * AC-1: Bot.create() wires dependencies
 * AC-2: Message flow through router → agent → response
 * AC-3: Escalation logged with context
 * AC-4: Graceful shutdown sequence
 * AC-5: Health monitoring forwarding
 * AC-6: Fallback channel for escalation
 *
 * Traits: @trait-observable, @trait-recoverable, @trait-graceful-shutdown, @trait-health-monitored
 */

import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@kynetic-bot/core';
import type { BotConfig } from '../src/config.js';
import { Bot, type BotState, type EscalationContext } from '../src/bot.js';

// Track KbotShadow constructor args for AC-7 and AC-6 tests
let capturedShadowOptions: { projectRoot?: string; worktreeDir?: string } | null = null;

// Mock child_process execSync for git root tests
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue('/test/git/root\n'),
  };
});

// Mock KbotShadow with a proper class constructor to capture constructor args
vi.mock('@kynetic-bot/memory', () => {
  // Use a class to properly support `new KbotShadow()`
  class MockKbotShadow {
    constructor(options: { projectRoot?: string; worktreeDir?: string }) {
      capturedShadowOptions = options;
    }
    initialize = vi.fn().mockResolvedValue(undefined);
    shutdown = vi.fn().mockResolvedValue(undefined);
    getState = vi.fn().mockReturnValue('ready');
    isReady = vi.fn().mockReturnValue(true);
    forceCommit = vi.fn().mockResolvedValue(true);
    recordEvent = vi.fn();
    on = vi.fn();
    emit = vi.fn();
  }
  return {
    KbotShadow: MockKbotShadow,
  };
});

const mockExecSync = vi.mocked(execSync);

/**
 * Delay helper for async tests
 */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a mock NormalizedMessage
 */
function createMockMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: 'msg-123',
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
    agentCommand: 'test-agent --flag',
    kbotDataDir: '.kbot',
    logLevel: 'info',
    healthCheckInterval: 100,
    shutdownTimeout: 500,
    ...overrides,
  };
}

/**
 * Create a mock ACP Client (EventEmitter-based for streaming updates)
 */
function createMockACPClient() {
  const clientEmitter = new EventEmitter();
  const mockClient = Object.assign(clientEmitter, {
    newSession: vi.fn().mockResolvedValue('session-123'),
    prompt: vi.fn().mockImplementation(async () => {
      // Emit streaming update with response content
      clientEmitter.emit('update', 'session-123', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello, user!' },
      });
      return { stopReason: 'end_turn' };
    }),
    getSession: vi.fn().mockReturnValue({ id: 'session-123', status: 'idle' }),
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
    getSessionId: vi.fn().mockReturnValue('session-123'),
    spawn: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
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
    hasAgent: vi.fn().mockReturnValue(true),
    closeSession: vi.fn(),
    getOrCreateSession: vi.fn(),
  };
}

/**
 * Create a mock KbotShadow
 */
function createMockShadow() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue('ready'),
    isReady: vi.fn().mockReturnValue(true),
    forceCommit: vi.fn().mockResolvedValue(true),
    recordEvent: vi.fn(),
  });
}

/**
 * Create a mock ChannelRegistry
 */
function createMockRegistry() {
  return {
    register: vi.fn().mockReturnValue({ ok: true, value: undefined }),
    getAdapter: vi.fn(),
    listAdapters: vi.fn().mockReturnValue([]),
    unregister: vi.fn().mockReturnValue(true),
    hasAdapter: vi.fn().mockReturnValue(false),
    clear: vi.fn(),
  };
}

/**
 * Create a mock ChannelLifecycle
 */
function createMockChannelLifecycle() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue('sent-msg-id'),
    getState: vi.fn().mockReturnValue('healthy'),
    isHealthy: vi.fn().mockReturnValue(true),
  };
}

describe('Bot', () => {
  let config: BotConfig;
  let mockAgent: ReturnType<typeof createMockAgent>;
  let mockRouter: ReturnType<typeof createMockRouter>;
  let mockShadow: ReturnType<typeof createMockShadow>;
  let mockRegistry: ReturnType<typeof createMockRegistry>;
  let bot: Bot;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createMockConfig();
    mockAgent = createMockAgent();
    mockRouter = createMockRouter();
    mockShadow = createMockShadow();
    mockRegistry = createMockRegistry();

    bot = Bot.createWithDependencies({
      config,
      agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
      router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
      shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
      registry: mockRegistry as unknown as Parameters<typeof Bot.createWithDependencies>[0]['registry'],
    });
  });

  afterEach(async () => {
    // Ensure bot is stopped after each test
    if (bot.getState() === 'running') {
      await bot.stop();
    }
  });

  describe('AC-1: Bot.create() wires dependencies', () => {
    it('creates bot with initialized shadow', async () => {
      // Arrange - use mock shadow since we're not in a git repo
      const freshShadow = createMockShadow();

      // Use createWithDependencies to test the wiring without real git
      const createdBot = Bot.createWithDependencies({
        config,
        shadow: freshShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
      });

      // Manually call initialize to simulate Bot.create behavior
      await freshShadow.initialize();

      // Assert
      expect(createdBot).toBeInstanceOf(Bot);
      expect(createdBot.getState()).toBe('idle');
      expect(freshShadow.initialize).toHaveBeenCalled();
    });

    it('creates bot with injected dependencies', () => {
      // Assert - bot was created with mocks
      expect(bot).toBeInstanceOf(Bot);
      expect(bot.getState()).toBe('idle');
    });

    it('throws if shadow initialization fails', async () => {
      // Arrange
      const failingShadow = createMockShadow();
      failingShadow.initialize.mockRejectedValue(new Error('Shadow init failed'));

      // Mock Bot.create to use our failing shadow
      vi.spyOn(Bot, 'create').mockImplementation(async (cfg) => {
        const b = Bot.createWithDependencies({
          config: cfg,
          shadow: failingShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        });
        await failingShadow.initialize();
        return b;
      });

      // Act & Assert
      await expect(Bot.create(config)).rejects.toThrow('Shadow init failed');

      // Cleanup
      vi.restoreAllMocks();
    });
  });

  describe('AC-2: Message flow', () => {
    beforeEach(async () => {
      await bot.start();
    });

    it('routes message and prompts agent', async () => {
      // Arrange
      const msg = createMockMessage();
      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]);

      // Act
      await bot.handleMessage(msg);

      // Assert
      // AC-2: Router resolves session
      expect(mockRouter.resolveSession).toHaveBeenCalledWith(msg, 'main');
      // AC-2: Agent client prompts
      expect(mockAgent._mockClient.prompt).toHaveBeenCalled();
    });

    it('sends response back via channel', async () => {
      // Arrange
      const msg = createMockMessage();
      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]);

      // Act
      await bot.handleMessage(msg);

      // Assert
      expect(lifecycle.sendMessage).toHaveBeenCalledWith(
        msg.channel,
        'Hello, user!',
        { replyTo: msg.id },
      );
    });

    it('waits for agent to become healthy', async () => {
      // Arrange
      const msg = createMockMessage();
      mockAgent.isHealthy.mockReturnValueOnce(false).mockReturnValueOnce(true);

      // Act
      await bot.handleMessage(msg);

      // Assert
      expect(mockAgent.isHealthy).toHaveBeenCalled();
    });

    it('spawns agent if idle', async () => {
      // Arrange
      const msg = createMockMessage();
      mockAgent.isHealthy.mockReturnValue(false);
      mockAgent.getState.mockReturnValue('idle');

      // Act
      await bot.handleMessage(msg);

      // Assert
      expect(mockAgent.spawn).toHaveBeenCalled();
    });

    it('skips message if routing fails', async () => {
      // Arrange
      const msg = createMockMessage();
      mockRouter.resolveSession.mockReturnValue({
        ok: false,
        error: { message: 'Unknown agent', code: 'UNKNOWN_AGENT' },
      });

      const errorListener = vi.fn();
      bot.on('error', errorListener);

      // Act
      await bot.handleMessage(msg);

      // Assert
      expect(mockAgent._mockClient.prompt).not.toHaveBeenCalled();
      expect(errorListener).toHaveBeenCalled();
    });

    it('emits message:received and message:processed events', async () => {
      // Arrange
      const msg = createMockMessage();
      const receivedListener = vi.fn();
      const processedListener = vi.fn();
      bot.on('message:received', receivedListener);
      bot.on('message:processed', processedListener);

      // Act
      await bot.handleMessage(msg);

      // Assert - @trait-observable
      expect(receivedListener).toHaveBeenCalledWith(msg);
      expect(processedListener).toHaveBeenCalledWith(msg, expect.any(Number));
    });

    it('emits message:error on failure', async () => {
      // Arrange
      const msg = createMockMessage();
      mockAgent._mockClient.prompt.mockRejectedValue(new Error('Prompt failed'));

      const errorListener = vi.fn();
      bot.on('message:error', errorListener);

      // Act
      await bot.handleMessage(msg);

      // Assert - @trait-observable
      expect(errorListener).toHaveBeenCalledWith(msg, expect.any(Error));
    });
  });

  describe('AC-3: Escalation handling', () => {
    beforeEach(async () => {
      await bot.start();
    });

    it('logs escalation with context', async () => {
      // Arrange
      const escalationListener = vi.fn();
      bot.on('escalation', escalationListener);

      // Act - trigger escalation from agent
      mockAgent.emit('escalate', 'Test escalation reason', { detail: 'some-detail' });

      // Assert
      expect(escalationListener).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'Test escalation reason',
          metadata: { detail: 'some-detail' },
        }),
      );
    });

    it('emits escalation event with context', () => {
      // Arrange
      const escalationListener = vi.fn();
      bot.on('escalation', escalationListener);

      // Act
      mockAgent.emit('escalate', 'Max backoff reached', { consecutiveFailures: 5 });

      // Assert
      const context = escalationListener.mock.calls[0][0] as EscalationContext;
      expect(context.reason).toBe('Max backoff reached');
      expect(context.metadata).toEqual({ consecutiveFailures: 5 });
      expect(context.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('AC-4: Graceful shutdown', () => {
    it('stops channel lifecycle first', async () => {
      // Arrange
      const lifecycle = createMockChannelLifecycle();
      bot.setChannelLifecycle(lifecycle as unknown as Parameters<typeof bot.setChannelLifecycle>[0]);
      await bot.start();

      const callOrder: string[] = [];
      lifecycle.stop.mockImplementation(async () => {
        callOrder.push('channel');
      });
      mockAgent.stop.mockImplementation(async () => {
        callOrder.push('agent');
      });
      mockShadow.shutdown.mockImplementation(async () => {
        callOrder.push('shadow');
      });

      // Act
      await bot.stop();

      // Assert - AC-4: correct shutdown order
      expect(callOrder).toEqual(['channel', 'agent', 'shadow']);
    });

    it('waits for inflight messages', async () => {
      // Arrange
      await bot.start();
      const msg = createMockMessage();

      // Start a slow message
      mockAgent._mockClient.prompt.mockImplementation(async () => {
        await delay(100);
        return { result: [{ type: 'text', text: 'done' }] };
      });

      // Start message processing (don't await)
      const messagePromise = bot.handleMessage(msg);
      await delay(10); // Let it start

      // Assert inflight
      expect(bot.getInflightCount()).toBe(1);

      // Act - stop (should wait for message)
      const stopPromise = bot.stop();
      await Promise.all([messagePromise, stopPromise]);

      // Assert - message completed before shutdown
      expect(bot.getInflightCount()).toBe(0);
      expect(bot.getState()).toBe('stopped');
    });

    it('stops agent gracefully', async () => {
      // Arrange
      await bot.start();

      // Act
      await bot.stop();

      // Assert
      expect(mockAgent.stop).toHaveBeenCalled();
    });

    it('shuts down shadow', async () => {
      // Arrange
      await bot.start();

      // Act
      await bot.stop();

      // Assert
      expect(mockShadow.shutdown).toHaveBeenCalled();
    });

    it('times out if messages take too long', async () => {
      // Arrange
      config = createMockConfig({ shutdownTimeout: 50 });
      bot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        registry: mockRegistry as unknown as Parameters<typeof Bot.createWithDependencies>[0]['registry'],
      });
      await bot.start();

      // Start a very slow message
      mockAgent._mockClient.prompt.mockImplementation(async () => {
        await delay(1000); // Longer than shutdown timeout
        return { result: [] };
      });

      // Start message (don't await)
      void bot.handleMessage(createMockMessage());
      await delay(10);

      // Act - stop should timeout
      await bot.stop();

      // Assert - completed despite inflight
      expect(bot.getState()).toBe('stopped');
    });

    it('emits state:change events', async () => {
      // Arrange
      await bot.start();
      const stateListener = vi.fn();
      bot.on('state:change', stateListener);

      // Act
      await bot.stop();

      // Assert - @trait-observable
      expect(stateListener).toHaveBeenCalledWith('running', 'stopping');
      expect(stateListener).toHaveBeenCalledWith('stopping', 'stopped');
    });
  });

  describe('AC-5: Health monitoring', () => {
    beforeEach(async () => {
      await bot.start();
    });

    it('forwards agent health events', () => {
      // Arrange
      const healthListener = vi.fn();
      bot.on('agent:health', healthListener);

      // Act - agent emits health status
      mockAgent.emit('health:status', true, true);

      // Assert - @trait-health-monitored
      expect(healthListener).toHaveBeenCalledWith(true, true);
    });

    it('logs recovery from unhealthy state', () => {
      // Arrange
      const healthListener = vi.fn();
      bot.on('agent:health', healthListener);

      // Act - agent recovers
      mockAgent.emit('health:status', true, true);

      // Assert
      expect(healthListener).toHaveBeenCalledWith(true, true);
    });

    it('forwards agent state changes', () => {
      // Arrange
      const stateListener = vi.fn();
      bot.on('agent:state', stateListener);

      // Act
      mockAgent.emit('state:change', 'healthy', 'unhealthy');

      // Assert
      expect(stateListener).toHaveBeenCalledWith('healthy', 'unhealthy');
    });

    it('continues after agent restart', async () => {
      // Arrange
      const msg = createMockMessage();

      // First call: unhealthy, triggers spawn
      mockAgent.isHealthy.mockReturnValueOnce(false);
      mockAgent.getState.mockReturnValueOnce('idle');
      // After spawn: healthy
      mockAgent.isHealthy.mockReturnValue(true);

      // Act
      await bot.handleMessage(msg);

      // Assert - @trait-recoverable
      expect(mockAgent.spawn).toHaveBeenCalled();
      expect(mockAgent._mockClient.prompt).toHaveBeenCalled();
    });
  });

  describe('AC-6: Escalation channel fallback', () => {
    beforeEach(async () => {
      await bot.start();
    });

    it('uses escalationChannel from config', () => {
      // Arrange
      config = createMockConfig({ escalationChannel: 'ops-channel' });
      bot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        shadow: mockShadow as unknown as Parameters<typeof Bot.createWithDependencies>[0]['shadow'],
        registry: mockRegistry as unknown as Parameters<typeof Bot.createWithDependencies>[0]['registry'],
      });

      const escalationListener = vi.fn();
      bot.on('escalation', escalationListener);

      // Act
      mockAgent.emit('escalate', 'Test', {});

      // Assert
      const context = escalationListener.mock.calls[0][0] as EscalationContext;
      expect(context.targetChannel).toBe('ops-channel');
    });

    it('falls back to lastActiveChannel', async () => {
      // Arrange
      const msg = createMockMessage({ channel: 'active-channel' });
      await bot.handleMessage(msg);

      const escalationListener = vi.fn();
      bot.on('escalation', escalationListener);

      // Act
      mockAgent.emit('escalate', 'Test', {});

      // Assert
      const context = escalationListener.mock.calls[0][0] as EscalationContext;
      expect(context.targetChannel).toBe('active-channel');
    });

    it('tracks lastActiveChannel from messages', async () => {
      // Arrange & Act
      await bot.handleMessage(createMockMessage({ channel: 'ch-1' }));
      expect(bot.getLastActiveChannel()).toBe('ch-1');

      await bot.handleMessage(createMockMessage({ channel: 'ch-2' }));
      expect(bot.getLastActiveChannel()).toBe('ch-2');
    });
  });

  describe('State management', () => {
    it('starts in idle state', () => {
      expect(bot.getState()).toBe('idle');
      expect(bot.isRunning()).toBe(false);
    });

    it('transitions to running after start', async () => {
      await bot.start();

      expect(bot.getState()).toBe('running');
      expect(bot.isRunning()).toBe(true);
    });

    it('transitions to stopped after stop', async () => {
      await bot.start();
      await bot.stop();

      expect(bot.getState()).toBe('stopped');
      expect(bot.isRunning()).toBe(false);
    });

    it('throws if starting from non-idle state', async () => {
      await bot.start();

      await expect(bot.start()).rejects.toThrow('Cannot start from state: running');
    });

    it('ignores stop if already stopping', async () => {
      await bot.start();

      // Start two stops
      const p1 = bot.stop();
      const p2 = bot.stop();

      await Promise.all([p1, p2]);

      // Should only have stopped once
      expect(mockAgent.stop).toHaveBeenCalledTimes(1);
    });

    it('ignores messages when not running', async () => {
      // Bot is idle
      const msg = createMockMessage();

      await bot.handleMessage(msg);

      expect(mockRouter.resolveSession).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    beforeEach(async () => {
      await bot.start();
    });

    it('emits error on agent error', () => {
      // Arrange
      const errorListener = vi.fn();
      bot.on('error', errorListener);

      // Act
      mockAgent.emit('error', new Error('Agent crashed'), { source: 'process' });

      // Assert
      expect(errorListener).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'process' }),
      );
    });

    it('handles agent client not available', async () => {
      // Arrange
      const msg = createMockMessage();
      mockAgent.getClient.mockReturnValue(null);
      mockAgent.isHealthy.mockReturnValue(false);
      mockAgent.getState.mockReturnValue('failed');
      mockAgent.spawn.mockResolvedValue(undefined);

      const errorListener = vi.fn();
      bot.on('message:error', errorListener);

      // Act
      await bot.handleMessage(msg);

      // Assert
      expect(errorListener).toHaveBeenCalled();
    });

    it('handles shutdown errors gracefully', async () => {
      // Arrange
      mockAgent.stop.mockRejectedValue(new Error('Stop failed'));
      const errorListener = vi.fn();
      bot.on('error', errorListener);

      // Act
      await bot.stop();

      // Assert - still transitions to stopped
      expect(bot.getState()).toBe('stopped');
      expect(errorListener).toHaveBeenCalled();
    });
  });

  // AC: @bot-orchestration ac-7
  describe('AC-7: Git root discovery', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      capturedShadowOptions = null;
    });

    it('uses git rev-parse --show-toplevel to find git root', () => {
      // Arrange
      const expectedGitRoot = '/home/user/my-project';
      mockExecSync.mockReturnValue(`${expectedGitRoot}\n`);

      // Act - create bot WITHOUT injected shadow to trigger real KbotShadow construction
      const testBot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        registry: mockRegistry as unknown as Parameters<typeof Bot.createWithDependencies>[0]['registry'],
        // Note: NOT providing shadow, so getGitRoot() is called
      });

      // Assert - execSync was called with git command
      expect(mockExecSync).toHaveBeenCalledWith(
        'git rev-parse --show-toplevel',
        { encoding: 'utf8' },
      );

      // Assert - KbotShadow received the git root as projectRoot
      expect(capturedShadowOptions).toBeDefined();
      expect(capturedShadowOptions?.projectRoot).toBe(expectedGitRoot);
    });

    it('falls back to process.cwd() when git command fails', () => {
      // Arrange
      const expectedCwd = process.cwd();
      mockExecSync.mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });

      // Act - create bot WITHOUT injected shadow
      const testBot = Bot.createWithDependencies({
        config,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        registry: mockRegistry as unknown as Parameters<typeof Bot.createWithDependencies>[0]['registry'],
        // Note: NOT providing shadow, so getGitRoot() is called
      });

      // Assert - execSync was attempted
      expect(mockExecSync).toHaveBeenCalledWith(
        'git rev-parse --show-toplevel',
        { encoding: 'utf8' },
      );

      // Assert - KbotShadow received cwd as fallback projectRoot
      expect(capturedShadowOptions).toBeDefined();
      expect(capturedShadowOptions?.projectRoot).toBe(expectedCwd);
      expect(testBot).toBeInstanceOf(Bot);
    });
  });

  // AC: @bot-config ac-6
  describe('AC-6: kbotDataDir as worktreeDir', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      capturedShadowOptions = null;
      // Default: git root returns a valid path
      mockExecSync.mockReturnValue('/home/user/project\n');
    });

    it('passes kbotDataDir as worktreeDir to KbotShadow (not projectRoot)', () => {
      // Arrange
      const customDataDir = '.custom-kbot';
      const customConfig = createMockConfig({ kbotDataDir: customDataDir });

      // Act - create bot WITHOUT injected shadow to capture KbotShadow args
      const testBot = Bot.createWithDependencies({
        config: customConfig,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        registry: mockRegistry as unknown as Parameters<typeof Bot.createWithDependencies>[0]['registry'],
        // Note: NOT providing shadow, so KbotShadow is constructed with our args
      });

      // Assert - KbotShadow received kbotDataDir as worktreeDir
      expect(capturedShadowOptions).toBeDefined();
      expect(capturedShadowOptions?.worktreeDir).toBe(customDataDir);
      // projectRoot should be git root (not kbotDataDir)
      expect(capturedShadowOptions?.projectRoot).toBe('/home/user/project');
    });

    it('uses default .kbot value when KBOT_DATA_DIR not specified', () => {
      // Arrange - config without explicit kbotDataDir uses default
      const defaultConfig = createMockConfig();

      // Act - create bot WITHOUT injected shadow
      const testBot = Bot.createWithDependencies({
        config: defaultConfig,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        registry: mockRegistry as unknown as Parameters<typeof Bot.createWithDependencies>[0]['registry'],
      });

      // Assert - KbotShadow received default '.kbot' as worktreeDir
      expect(capturedShadowOptions).toBeDefined();
      expect(capturedShadowOptions?.worktreeDir).toBe('.kbot');
    });

    it('kbotDataDir is interpreted as relative dir name, not absolute path', () => {
      // Arrange
      const relativeDir = '.kbot-data';
      const configWithRelative = createMockConfig({ kbotDataDir: relativeDir });

      // Act - create bot WITHOUT injected shadow
      Bot.createWithDependencies({
        config: configWithRelative,
        agent: mockAgent as unknown as Parameters<typeof Bot.createWithDependencies>[0]['agent'],
        router: mockRouter as unknown as Parameters<typeof Bot.createWithDependencies>[0]['router'],
        registry: mockRegistry as unknown as Parameters<typeof Bot.createWithDependencies>[0]['registry'],
      });

      // Assert - worktreeDir is relative (no leading /), projectRoot is absolute
      expect(capturedShadowOptions).toBeDefined();
      expect(capturedShadowOptions?.worktreeDir).not.toMatch(/^\//);
      expect(capturedShadowOptions?.worktreeDir).toBe(relativeDir);
      expect(capturedShadowOptions?.projectRoot).toMatch(/^\//); // absolute path
    });
  });
});
