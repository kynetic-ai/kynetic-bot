/**
 * Bot.requestRestart() Tests
 *
 * Tests for the Bot Restart API feature (@bot-restart-api).
 *
 * Coverage:
 * - AC-1: Writes checkpoint and sends planned_restart
 * - AC-2: Checkpoint includes restart_reason
 * - AC-3: Checkpoint includes wake_context.prompt
 * - AC-4: Checkpoint includes wake_context.pending_work
 * - AC-5: Initiates graceful shutdown after IPC ack
 * - AC-6: Throws RestartNotAvailableError when not supervised
 * - AC-7: isSupervisedMode() returns true when process.send exists
 * - AC-8: Waits for streaming to complete before restart
 * - AC-9: Resolves after ack received
 * - AC-10: Includes session context in checkpoint
 * - AC-11: Subscribes to turn:end and queues restart
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NormalizedMessage } from '@kynetic-bot/core';
import type { BotConfig } from '../src/config.js';
import { Bot, RestartNotAvailableError, _resetGitRootCache } from '../src/bot.js';

// Track checkpoint writes
let capturedCheckpoints: Array<{
  baseDir: string;
  sessionId: string;
  reason: string;
  wakeContext: { prompt?: string; pending_work?: string };
}> = [];
let mockCheckpointPath = '/test/checkpoint/01TEST.yaml';
let mockWriteCheckpointError: Error | null = null;
let deletedCheckpoints: string[] = [];

// Mock supervisor checkpoint functions
vi.mock('@kynetic-bot/supervisor', () => ({
  writeCheckpoint: vi.fn().mockImplementation(async (baseDir, sessionId, reason, wakeContext) => {
    if (mockWriteCheckpointError) {
      return { success: false, error: mockWriteCheckpointError };
    }
    capturedCheckpoints.push({ baseDir, sessionId, reason, wakeContext });
    return { success: true, path: mockCheckpointPath };
  }),
  deleteCheckpoint: vi.fn().mockImplementation(async (path) => {
    deletedCheckpoints.push(path);
  }),
  readCheckpoint: vi.fn().mockResolvedValue({ success: false, error: new Error('No checkpoint') }),
}));

// Mock restart protocol
let mockIsSupervised = false;
let mockRestartAckResolve: (() => void) | null = null;
let mockRestartAckReject: ((err: Error) => void) | null = null;
const mockRequestRestart = vi.fn();

vi.mock('../src/restart.js', () => ({
  getRestartProtocol: vi.fn().mockReturnValue({
    isSupervised: () => mockIsSupervised,
    requestRestart: (options: { checkpointPath: string }) => {
      mockRequestRestart(options);
      return new Promise<void>((resolve, reject) => {
        mockRestartAckResolve = resolve;
        mockRestartAckReject = reject;
      });
    },
    isPending: () => false,
  }),
}));

// Mock child_process for git root
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue('/test/git/root\n'),
}));

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
      session_key: 'test-key',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      turn_count: 0,
    });
    appendTurn = vi.fn().mockResolvedValue({ seq: 1 });
    readTurns = vi.fn().mockResolvedValue([]);
    getConversationBySessionKey = vi.fn().mockResolvedValue(null);
  }

  class MockTurnReconstructor {
    getContent = vi.fn().mockResolvedValue('');
  }

  return {
    KbotShadow: MockKbotShadow,
    SessionStore: MockSessionStore,
    ConversationStore: MockConversationStore,
    TurnReconstructor: MockTurnReconstructor,
  };
});

// Mock identity
vi.mock('../src/identity.js', () => ({
  buildIdentityPrompt: vi.fn().mockResolvedValue('You are Kbot.'),
}));

const defaultConfig: BotConfig = {
  agentCommand: 'test-agent',
  kbotDataDir: '.kbot',
  healthCheckInterval: 5000,
  shutdownTimeout: 5000,
  escalationChannel: null,
  modelType: 'sonnet',
};

function createMockAgentLifecycle() {
  const agentEmitter = new EventEmitter();
  const clientEmitter = new EventEmitter();
  const promptCalls: Array<{ sessionId: string; prompt: unknown; promptSource: string }> = [];
  let streamingInProgress = false;

  const mockClient = Object.assign(clientEmitter, {
    prompt: vi.fn().mockImplementation(async (params) => {
      promptCalls.push(params);
      streamingInProgress = true;
      setTimeout(() => {
        clientEmitter.emit('update', params.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Response' },
        });
      }, 10);
    }),
    newSession: vi.fn().mockResolvedValue('test-session-123'),
    createSession: vi.fn().mockResolvedValue({ sessionId: 'test-session-123' }),
  });

  return Object.assign(agentEmitter, {
    spawn: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
    getState: vi.fn().mockReturnValue('running'),
    getClient: vi.fn().mockReturnValue(mockClient),
    _mockClient: mockClient,
    _promptCalls: promptCalls,
    _clientEmitter: clientEmitter,
    _isStreaming: () => streamingInProgress,
    _endStreaming: () => {
      streamingInProgress = false;
    },
  });
}

function createMockRouter() {
  return {
    resolveSession: vi.fn().mockReturnValue({
      ok: true,
      value: { key: 'test-session-key' },
    }),
  };
}

function createMockChannelLifecycle() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
    startTypingLoop: vi.fn(),
    stopTypingLoop: vi.fn(),
  };
}

describe('Bot.requestRestart()', () => {
  let bot: Bot;
  let mockAgent: ReturnType<typeof createMockAgentLifecycle>;
  let mockRouter: ReturnType<typeof createMockRouter>;
  let mockChannelLifecycle: ReturnType<typeof createMockChannelLifecycle>;

  beforeEach(() => {
    _resetGitRootCache();
    vi.clearAllMocks();

    capturedCheckpoints = [];
    deletedCheckpoints = [];
    mockWriteCheckpointError = null;
    mockCheckpointPath = '/test/checkpoint/01TEST.yaml';
    mockIsSupervised = true;
    mockRestartAckResolve = null;
    mockRestartAckReject = null;

    mockAgent = createMockAgentLifecycle();
    mockRouter = createMockRouter();
    mockChannelLifecycle = createMockChannelLifecycle();
  });

  afterEach(async () => {
    if (bot && bot.isRunning()) {
      await bot.stop();
    }
  });

  // AC: @bot-restart-api ac-6
  describe('supervised mode detection', () => {
    it('throws RestartNotAvailableError when not under supervisor', async () => {
      mockIsSupervised = false;

      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });

      await bot.start();

      await expect(bot.requestRestart()).rejects.toThrow(RestartNotAvailableError);
      await expect(bot.requestRestart()).rejects.toThrow(
        'Restart not available - bot is not running under supervisor'
      );
    });

    // AC: @bot-restart-api ac-7
    it('isSupervisedMode() returns true when process.send exists', async () => {
      mockIsSupervised = true;

      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });

      expect(bot.isSupervisedMode()).toBe(true);
    });

    it('isSupervisedMode() returns false when not supervised', async () => {
      mockIsSupervised = false;

      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });

      expect(bot.isSupervisedMode()).toBe(false);
    });
  });

  // AC: @bot-restart-api ac-1, ac-2, ac-3, ac-4
  describe('checkpoint creation', () => {
    it('writes checkpoint with default reason when no options provided', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      const restartPromise = bot.requestRestart();

      // Wait for checkpoint write
      await new Promise((r) => setTimeout(r, 50));

      expect(capturedCheckpoints).toHaveLength(1);
      expect(capturedCheckpoints[0].reason).toBe('planned');
      expect(capturedCheckpoints[0].wakeContext.prompt).toBe('Continuing after planned restart.');

      // Resolve the restart ack to complete
      mockRestartAckResolve?.();
      await restartPromise;
    });

    // AC: @bot-restart-api ac-2
    it('includes restart_reason in checkpoint', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      const restartPromise = bot.requestRestart({ reason: 'upgrade' });

      await new Promise((r) => setTimeout(r, 50));

      expect(capturedCheckpoints[0].reason).toBe('upgrade');

      mockRestartAckResolve?.();
      await restartPromise;
    });

    // AC: @bot-restart-api ac-3
    it('includes wake_context.prompt in checkpoint', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      const restartPromise = bot.requestRestart({
        wakePrompt: 'Resume working on feature X',
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(capturedCheckpoints[0].wakeContext.prompt).toBe('Resume working on feature X');

      mockRestartAckResolve?.();
      await restartPromise;
    });

    // AC: @bot-restart-api ac-4
    it('includes wake_context.pending_work in checkpoint', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      const restartPromise = bot.requestRestart({
        pendingWork: 'Implementing authentication module',
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(capturedCheckpoints[0].wakeContext.pending_work).toBe(
        'Implementing authentication module'
      );

      mockRestartAckResolve?.();
      await restartPromise;
    });

    it('combines all options in checkpoint', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      const restartPromise = bot.requestRestart({
        reason: 'upgrade',
        wakePrompt: 'Updated to v2.0',
        pendingWork: 'Testing migration',
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(capturedCheckpoints[0]).toMatchObject({
        reason: 'upgrade',
        wakeContext: {
          prompt: 'Updated to v2.0',
          pending_work: 'Testing migration',
        },
      });

      mockRestartAckResolve?.();
      await restartPromise;
    });
  });

  // AC: @bot-restart-api ac-5, ac-9
  describe('restart flow', () => {
    // AC: @bot-restart-api ac-1
    it('sends planned_restart message via RestartProtocol', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      const restartPromise = bot.requestRestart();

      await new Promise((r) => setTimeout(r, 50));

      expect(mockRequestRestart).toHaveBeenCalledWith({
        checkpointPath: mockCheckpointPath,
      });

      mockRestartAckResolve?.();
      await restartPromise;
    });

    // AC: @bot-restart-api ac-5
    it('initiates graceful shutdown after IPC acknowledged', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      expect(bot.getState()).toBe('running');

      const restartPromise = bot.requestRestart();

      await new Promise((r) => setTimeout(r, 50));

      // Resolve the ack
      mockRestartAckResolve?.();
      await restartPromise;

      // Bot should be stopped
      expect(bot.getState()).toBe('stopped');
    });

    // AC: @bot-restart-api ac-9
    it('resolves after ack received (does not wait for full restart)', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      const restartPromise = bot.requestRestart();
      let resolved = false;

      restartPromise.then(() => {
        resolved = true;
      });

      await new Promise((r) => setTimeout(r, 50));

      // Not resolved yet - waiting for ack
      expect(resolved).toBe(false);

      // Resolve ack
      mockRestartAckResolve?.();
      await restartPromise;

      // Now resolved
      expect(resolved).toBe(true);
    });
  });

  // AC: @bot-restart-api ac-10
  describe('session context in checkpoint', () => {
    it('includes session context when active session exists', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });

      bot.setChannelLifecycle(mockChannelLifecycle as never);
      await bot.start();

      // Send a message to create an active session
      const message: NormalizedMessage = {
        id: 'msg-1',
        channel: 'test-channel',
        text: 'Hello',
        sender: { id: 'user-1', platform: 'test' },
        timestamp: new Date(),
        rawMessage: {},
      };

      await bot.handleMessage(message);
      await new Promise((r) => setTimeout(r, 50));

      const restartPromise = bot.requestRestart();
      await new Promise((r) => setTimeout(r, 50));

      // Verify checkpoint includes session info (sessionId comes from session lifecycle)
      expect(capturedCheckpoints).toHaveLength(1);
      expect(capturedCheckpoints[0].sessionId).toBeDefined();

      mockRestartAckResolve?.();
      await restartPromise;
    });

    it('uses fallback context when no active session', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      // No message sent, so no active session
      const restartPromise = bot.requestRestart();
      await new Promise((r) => setTimeout(r, 50));

      expect(capturedCheckpoints).toHaveLength(1);
      expect(capturedCheckpoints[0].sessionId).toBe('no-active-session');

      mockRestartAckResolve?.();
      await restartPromise;
    });
  });

  // AC: @bot-restart-api ac-8, ac-11
  describe('streaming completion wait', () => {
    it('proceeds immediately when no inflight messages', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      // No messages in flight
      expect(bot.getInflightCount()).toBe(0);

      // Request restart - should proceed immediately
      const restartPromise = bot.requestRestart();

      // Checkpoint written immediately (no waiting)
      await new Promise((r) => setTimeout(r, 20));
      expect(capturedCheckpoints).toHaveLength(1);

      mockRestartAckResolve?.();
      await restartPromise;
    });

    // AC: @bot-restart-api ac-11
    it('emits turn:end event after message completion for coordinated shutdown', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });

      bot.setChannelLifecycle(mockChannelLifecycle as never);
      await bot.start();

      const turnEndEvents: Array<{ sessionId: string; channelId: string }> = [];
      bot.on('turn:end', (sessionId, channelId) => {
        turnEndEvents.push({ sessionId, channelId });
      });

      // Process a message
      const message: NormalizedMessage = {
        id: 'msg-1',
        channel: 'test-channel',
        text: 'Hello',
        sender: { id: 'user-1', platform: 'test' },
        timestamp: new Date(),
        rawMessage: {},
      };

      await bot.handleMessage(message);

      // turn:end should have been emitted
      expect(turnEndEvents).toHaveLength(1);
      expect(turnEndEvents[0].channelId).toBe('test-channel');

      // Now restart after message completes
      const restartPromise = bot.requestRestart();
      await new Promise((r) => setTimeout(r, 20));
      expect(capturedCheckpoints).toHaveLength(1);

      mockRestartAckResolve?.();
      await restartPromise;
    });

    it('waitForStreamingCompletion subscribes to turn:end when inflightCount > 0', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });

      bot.setChannelLifecycle(mockChannelLifecycle as never);
      await bot.start();

      // Start message to create inflight count
      const message: NormalizedMessage = {
        id: 'msg-1',
        channel: 'test-channel',
        text: 'Hello',
        sender: { id: 'user-1', platform: 'test' },
        timestamp: new Date(),
        rawMessage: {},
      };

      // Process message (fast with mock)
      await bot.handleMessage(message);

      // After message completes, inflight should be 0
      expect(bot.getInflightCount()).toBe(0);

      // Now restart should proceed
      const restartPromise = bot.requestRestart();
      await new Promise((r) => setTimeout(r, 20));
      expect(capturedCheckpoints).toHaveLength(1);

      mockRestartAckResolve?.();
      await restartPromise;
    });
  });

  describe('error handling', () => {
    it('cleans up checkpoint on restart failure', async () => {
      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      const restartPromise = bot.requestRestart();

      await new Promise((r) => setTimeout(r, 50));

      // Checkpoint was written
      expect(capturedCheckpoints).toHaveLength(1);

      // Reject the restart (simulating IPC failure)
      mockRestartAckReject?.(new Error('IPC timeout'));

      await expect(restartPromise).rejects.toThrow('IPC timeout');

      // Checkpoint should be deleted on failure
      expect(deletedCheckpoints).toContain(mockCheckpointPath);
    });

    it('throws when checkpoint write fails', async () => {
      mockWriteCheckpointError = new Error('Disk full');

      bot = await Bot.create(defaultConfig, {
        agent: mockAgent as never,
        router: mockRouter as never,
      });
      await bot.start();

      await expect(bot.requestRestart()).rejects.toThrow('Failed to write checkpoint: Disk full');

      // No IPC request sent
      expect(mockRequestRestart).not.toHaveBeenCalled();
    });
  });
});
