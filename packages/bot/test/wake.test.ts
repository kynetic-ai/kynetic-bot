/**
 * Wake Context Injection Tests
 *
 * Test coverage for wake context injection feature (@wake-injection).
 *
 * Coverage:
 * - AC-1: Checkpoint read/validation on bot start
 * - AC-2: Wake prompt injected BEFORE identity prompt
 * - AC-3: Wake prompt marked with promptSource: 'system'
 * - AC-4: Pending work included in wake prompt
 * - AC-5: Instructions included in wake prompt
 * - AC-6: Checkpoint deleted and event emitted after consumption
 * - AC-7: No checkpoint = identity only (no wake injection)
 * - AC-8: Large wake prompts truncated with warning
 * - AC-9: Message order: wake context → identity → restored history
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Bot, _resetGitRootCache } from '../src/bot.js';
import type { BotConfig } from '../src/config.js';
import type { NormalizedMessage } from '@kynetic-bot/core';
import type { Checkpoint, WakeContext } from '@kynetic-bot/supervisor';
import { generateWakePrompt } from '../src/wake.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Mock dependencies
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue('/test/root\n'),
}));

vi.mock('@kynetic-bot/memory', () => {
  class MockKbotShadow {
    initialize = vi.fn().mockResolvedValue(undefined);
    shutdown = vi.fn().mockResolvedValue(undefined);
  }

  class MockSessionStore {
    createSession = vi.fn().mockResolvedValue({});
    updateSessionStatus = vi.fn().mockResolvedValue({});
    appendEvent = vi.fn().mockImplementation(async (event) => ({
      ...event,
      seq: 1,
      ts: Date.now(),
    }));
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

// Mock supervisor checkpoint functions
let mockCheckpointContent: Checkpoint | null = null;
let mockCheckpointError: Error | null = null;
let mockCheckpointWarning: string | null = null;
let deletedCheckpoints: string[] = [];

vi.mock('@kynetic-bot/supervisor', async () => {
  return {
    readCheckpoint: vi.fn().mockImplementation(async (path: string) => {
      if (mockCheckpointError) {
        return { success: false, error: mockCheckpointError };
      }
      if (mockCheckpointWarning) {
        return { success: false, warning: mockCheckpointWarning };
      }
      if (mockCheckpointContent) {
        return { success: true, checkpoint: mockCheckpointContent };
      }
      return { success: false, error: new Error('No checkpoint found') };
    }),
    deleteCheckpoint: vi.fn().mockImplementation(async (path: string) => {
      deletedCheckpoints.push(path);
    }),
  };
});

// Mock identity
vi.mock('../src/identity.js', () => ({
  buildIdentityPrompt: vi.fn().mockResolvedValue('You are Kbot, a helpful assistant.'),
}));

const defaultConfig: BotConfig = {
  agentCommand: 'test-agent',
  kbotDataDir: '.kbot',
  healthCheckInterval: 5000,
  shutdownTimeout: 5000,
  escalationChannel: null,
  modelType: 'sonnet',
};

// Mock agent lifecycle
function createMockAgentLifecycle() {
  const emitter = new EventEmitter();
  const promptCalls: Array<{ sessionId: string; prompt: unknown; promptSource: string }> = [];

  return {
    spawn: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
    getState: vi.fn().mockReturnValue('running'),
    getClient: vi.fn().mockReturnValue({
      prompt: vi.fn().mockImplementation(async (params) => {
        promptCalls.push(params);
        // Simulate agent response
        setTimeout(() => {
          emitter.emit('update', params.sessionId, {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Response' },
          });
        }, 10);
      }),
      on: vi.fn().mockImplementation((event, handler) => {
        emitter.on(event, handler);
      }),
      off: vi.fn().mockImplementation((event, handler) => {
        emitter.off(event, handler);
      }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'test-session-123' }),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'test-session-123' }),
    }),
    on: vi.fn(),
    off: vi.fn(),
    _promptCalls: promptCalls,
    _emitter: emitter,
  };
}

// Mock router
function createMockRouter() {
  return {
    resolveSession: vi.fn().mockReturnValue({
      ok: true,
      value: { key: 'test-session-key' },
    }),
  };
}

// Mock channel lifecycle
function createMockChannelLifecycle() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg-123' }),
    startTypingLoop: vi.fn(),
    stopTypingLoop: vi.fn(),
  };
}

describe('Wake Context Injection', () => {
  let bot: Bot;
  let mockAgent: ReturnType<typeof createMockAgentLifecycle>;
  let mockRouter: ReturnType<typeof createMockRouter>;
  let mockChannelLifecycle: ReturnType<typeof createMockChannelLifecycle>;

  beforeEach(() => {
    _resetGitRootCache();
    mockCheckpointContent = null;
    mockCheckpointError = null;
    mockCheckpointWarning = null;
    deletedCheckpoints = [];

    mockAgent = createMockAgentLifecycle();
    mockRouter = createMockRouter();
    mockChannelLifecycle = createMockChannelLifecycle();
  });

  afterEach(async () => {
    if (bot && bot.isRunning()) {
      await bot.stop();
    }
  });

  // AC: @wake-injection ac-1
  it('reads and validates checkpoint when checkpointPath provided', async () => {
    mockCheckpointContent = {
      version: 1,
      session_id: 'session-abc',
      restart_reason: 'planned',
      wake_context: {
        prompt: 'You are restarting after a planned restart.',
      },
      created_at: new Date().toISOString(),
    };

    bot = await Bot.create(defaultConfig, {
      checkpointPath: '/test/checkpoint.yaml',
      agent: mockAgent as never,
      router: mockRouter as never,
    });

    expect(bot).toBeDefined();
    // Checkpoint should be loaded internally (verified by AC-2 test)
  });

  // AC: @wake-injection ac-1 (error case)
  it('continues without checkpoint if validation fails', async () => {
    mockCheckpointError = new Error('Invalid checkpoint format');

    bot = await Bot.create(defaultConfig, {
      checkpointPath: '/test/invalid-checkpoint.yaml',
      agent: mockAgent as never,
      router: mockRouter as never,
    });

    expect(bot).toBeDefined();
    // Bot should start normally without checkpoint
  });

  // AC: @wake-injection ac-1 (warning case - expired)
  it('continues without checkpoint if checkpoint is too old', async () => {
    mockCheckpointWarning = 'Checkpoint is 25 hours old (max 24 hours)';

    bot = await Bot.create(defaultConfig, {
      checkpointPath: '/test/expired-checkpoint.yaml',
      agent: mockAgent as never,
      router: mockRouter as never,
    });

    expect(bot).toBeDefined();
    // Bot should start normally without checkpoint
  });

  // AC: @wake-injection ac-2, ac-3
  it('injects wake prompt BEFORE identity prompt with promptSource: system', async () => {
    mockCheckpointContent = {
      version: 1,
      session_id: 'session-abc',
      restart_reason: 'planned',
      wake_context: {
        prompt: 'You are restarting after a planned restart.',
      },
      created_at: new Date().toISOString(),
    };

    bot = await Bot.create(defaultConfig, {
      checkpointPath: '/test/checkpoint.yaml',
      agent: mockAgent as never,
      router: mockRouter as never,
    });

    bot.setChannelLifecycle(mockChannelLifecycle as never);
    await bot.start();

    const message: NormalizedMessage = {
      id: 'msg-1',
      channel: 'test-channel',
      text: 'Hello',
      sender: { id: 'user-1', platform: 'test' },
      timestamp: new Date(),
      rawMessage: {},
    };

    await bot.handleMessage(message);

    // Wait for agent processing
    await new Promise((resolve) => setTimeout(resolve, 50));

    const promptCalls = mockAgent._promptCalls;
    expect(promptCalls.length).toBeGreaterThanOrEqual(2);

    // First prompt should be wake context
    expect(promptCalls[0].promptSource).toBe('system');
    expect((promptCalls[0].prompt as Array<{ text: string }>)[0].text).toContain(
      'You are restarting'
    );

    // Second prompt should be identity
    expect(promptCalls[1].promptSource).toBe('system');
    expect((promptCalls[1].prompt as Array<{ text: string }>)[0].text).toContain(
      'You are Kbot, a helpful assistant'
    );
  });

  // AC: @wake-injection ac-4
  it('includes pending_work in wake prompt when present', async () => {
    mockCheckpointContent = {
      version: 1,
      session_id: 'session-abc',
      restart_reason: 'planned',
      wake_context: {
        prompt: 'You are restarting.',
        pending_work: 'Implementing feature X',
      },
      created_at: new Date().toISOString(),
    };

    bot = await Bot.create(defaultConfig, {
      checkpointPath: '/test/checkpoint.yaml',
      agent: mockAgent as never,
      router: mockRouter as never,
    });

    bot.setChannelLifecycle(mockChannelLifecycle as never);
    await bot.start();

    const message: NormalizedMessage = {
      id: 'msg-1',
      channel: 'test-channel',
      text: 'Hello',
      sender: { id: 'user-1', platform: 'test' },
      timestamp: new Date(),
      rawMessage: {},
    };

    await bot.handleMessage(message);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const promptCalls = mockAgent._promptCalls;
    const wakePrompt = (promptCalls[0].prompt as Array<{ text: string }>)[0].text;
    expect(wakePrompt).toContain('You were working on: Implementing feature X');
  });

  // AC: @wake-injection ac-5
  it('includes instructions in wake prompt when present', async () => {
    mockCheckpointContent = {
      version: 1,
      session_id: 'session-abc',
      restart_reason: 'planned',
      wake_context: {
        prompt: 'You are restarting.',
        instructions: 'Complete the tests for module Y',
      },
      created_at: new Date().toISOString(),
    };

    bot = await Bot.create(defaultConfig, {
      checkpointPath: '/test/checkpoint.yaml',
      agent: mockAgent as never,
      router: mockRouter as never,
    });

    bot.setChannelLifecycle(mockChannelLifecycle as never);
    await bot.start();

    const message: NormalizedMessage = {
      id: 'msg-1',
      channel: 'test-channel',
      text: 'Hello',
      sender: { id: 'user-1', platform: 'test' },
      timestamp: new Date(),
      rawMessage: {},
    };

    await bot.handleMessage(message);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const promptCalls = mockAgent._promptCalls;
    const wakePrompt = (promptCalls[0].prompt as Array<{ text: string }>)[0].text;
    expect(wakePrompt).toContain('Instructions: Complete the tests for module Y');
  });

  // AC: @wake-injection ac-6
  it('deletes checkpoint file and emits event after consumption', async () => {
    const checkpointPath = '/test/checkpoint.yaml';
    mockCheckpointContent = {
      version: 1,
      session_id: 'session-abc',
      restart_reason: 'planned',
      wake_context: {
        prompt: 'You are restarting.',
      },
      created_at: new Date().toISOString(),
    };

    bot = await Bot.create(defaultConfig, {
      checkpointPath,
      agent: mockAgent as never,
      router: mockRouter as never,
    });

    const consumedEvents: Array<{ checkpointPath: string; sessionId: string }> = [];
    bot.on('checkpoint:consumed', (data) => {
      consumedEvents.push(data);
    });

    bot.setChannelLifecycle(mockChannelLifecycle as never);
    await bot.start();

    const message: NormalizedMessage = {
      id: 'msg-1',
      channel: 'test-channel',
      text: 'Hello',
      sender: { id: 'user-1', platform: 'test' },
      timestamp: new Date(),
      rawMessage: {},
    };

    await bot.handleMessage(message);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Checkpoint should be deleted
    expect(deletedCheckpoints).toContain(checkpointPath);

    // Event should be emitted
    expect(consumedEvents).toHaveLength(1);
    expect(consumedEvents[0]).toEqual({
      checkpointPath,
      sessionId: 'session-abc',
    });
  });

  // AC: @wake-injection ac-7
  it('sends identity only when no checkpoint provided', async () => {
    // No checkpoint
    bot = await Bot.create(defaultConfig, {
      agent: mockAgent as never,
      router: mockRouter as never,
    });

    bot.setChannelLifecycle(mockChannelLifecycle as never);
    await bot.start();

    const message: NormalizedMessage = {
      id: 'msg-1',
      channel: 'test-channel',
      text: 'Hello',
      sender: { id: 'user-1', platform: 'test' },
      timestamp: new Date(),
      rawMessage: {},
    };

    await bot.handleMessage(message);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const promptCalls = mockAgent._promptCalls;

    // Should have identity prompt but NOT wake prompt
    expect(promptCalls.length).toBeGreaterThanOrEqual(1);
    expect(promptCalls[0].promptSource).toBe('system');
    expect((promptCalls[0].prompt as Array<{ text: string }>)[0].text).toContain(
      'You are Kbot, a helpful assistant'
    );
    expect((promptCalls[0].prompt as Array<{ text: string }>)[0].text).not.toContain(
      'You are restarting'
    );
  });

  // AC: @wake-injection ac-8
  it('truncates very large wake prompts with warning', () => {
    const largeInstructions = 'x'.repeat(15000);
    const wakeContext: WakeContext = {
      prompt: 'You are restarting after a planned restart.',
      pending_work: 'Working on feature X',
      instructions: largeInstructions,
    };

    const result = generateWakePrompt(wakeContext);

    // Should be truncated
    expect(result.length).toBeLessThan(11000); // Less than max + margin
    expect(result).toContain('[TRUNCATED]');
    expect(result).toContain('[Warning: Wake context was truncated');
    // Essential info preserved
    expect(result).toContain('You are restarting');
    expect(result).toContain('You were working on: Working on feature X');
  });

  // AC: @wake-injection ac-9
  it('ensures message order: wake context, then identity, then user prompt', async () => {
    mockCheckpointContent = {
      version: 1,
      session_id: 'session-abc',
      restart_reason: 'planned',
      wake_context: {
        prompt: 'You are restarting.',
      },
      created_at: new Date().toISOString(),
    };

    bot = await Bot.create(defaultConfig, {
      checkpointPath: '/test/checkpoint.yaml',
      agent: mockAgent as never,
      router: mockRouter as never,
    });

    bot.setChannelLifecycle(mockChannelLifecycle as never);
    await bot.start();

    const message: NormalizedMessage = {
      id: 'msg-1',
      channel: 'test-channel',
      text: 'Hello',
      sender: { id: 'user-1', platform: 'test' },
      timestamp: new Date(),
      rawMessage: {},
    };

    await bot.handleMessage(message);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const promptCalls = mockAgent._promptCalls;
    expect(promptCalls.length).toBe(3);

    // Order verification
    expect(promptCalls[0].promptSource).toBe('system');
    expect((promptCalls[0].prompt as Array<{ text: string }>)[0].text).toContain(
      'You are restarting'
    );

    expect(promptCalls[1].promptSource).toBe('system');
    expect((promptCalls[1].prompt as Array<{ text: string }>)[0].text).toContain('You are Kbot');

    expect(promptCalls[2].promptSource).toBe('user');
    expect((promptCalls[2].prompt as Array<{ text: string }>)[0].text).toBe('Hello');
  });

  // Edge case: checkpoint only consumed once (subsequent messages skip it)
  it('only injects wake context once per bot instance', async () => {
    mockCheckpointContent = {
      version: 1,
      session_id: 'session-abc',
      restart_reason: 'planned',
      wake_context: {
        prompt: 'You are restarting.',
      },
      created_at: new Date().toISOString(),
    };

    bot = await Bot.create(defaultConfig, {
      checkpointPath: '/test/checkpoint.yaml',
      agent: mockAgent as never,
      router: mockRouter as never,
    });

    bot.setChannelLifecycle(mockChannelLifecycle as never);
    await bot.start();

    // First message - should inject wake context
    const message1: NormalizedMessage = {
      id: 'msg-1',
      channel: 'test-channel',
      text: 'Hello',
      sender: { id: 'user-1', platform: 'test' },
      timestamp: new Date(),
      rawMessage: {},
    };

    await bot.handleMessage(message1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const promptCallsAfterFirst = mockAgent._promptCalls.length;

    // Second message on same session - should NOT inject wake context again
    const message2: NormalizedMessage = {
      id: 'msg-2',
      channel: 'test-channel',
      text: 'How are you?',
      sender: { id: 'user-1', platform: 'test' },
      timestamp: new Date(),
      rawMessage: {},
    };

    await bot.handleMessage(message2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should only have one additional user prompt, no system prompts
    expect(mockAgent._promptCalls.length).toBe(promptCallsAfterFirst + 1);
    expect(mockAgent._promptCalls[mockAgent._promptCalls.length - 1].promptSource).toBe('user');
  });
});
