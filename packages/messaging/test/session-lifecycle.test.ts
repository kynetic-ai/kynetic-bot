/**
 * SessionLifecycleManager Tests
 *
 * Tests for session lifecycle management including reuse, rotation,
 * restart recovery, and per-key locking.
 *
 * @see @mem-session-lifecycle
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SessionLifecycleManager,
  type SessionACPClient,
  type SessionConversationStore,
  type SessionMemoryStore,
  type ContextUsageUpdate,
} from '../src/session/session-lifecycle.js';

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockACPClient(): SessionACPClient & { sessionCounter: number } {
  let sessionCounter = 0;
  return {
    get sessionCounter() {
      return sessionCounter;
    },
    newSession: vi.fn().mockImplementation(async () => {
      sessionCounter++;
      return `acp-session-${sessionCounter}`;
    }),
  };
}

function createMockConversationStore(): SessionConversationStore & {
  conversations: Map<string, { id: string; updated_at: string }>;
} {
  const conversations = new Map<string, { id: string; updated_at: string }>();
  return {
    conversations,
    getConversationBySessionKey: vi.fn().mockImplementation(async (sessionKey: string) => {
      return conversations.get(sessionKey) ?? null;
    }),
  };
}

function createMockSessionStore(): SessionMemoryStore & { sessions: Map<string, unknown> } {
  const sessions = new Map<string, unknown>();
  return {
    sessions,
    createSession: vi.fn().mockImplementation(async (params) => {
      sessions.set(params.id, params);
    }),
    completeSession: vi.fn().mockImplementation(async () => {
      // No-op
    }),
  };
}

function createUsageUpdate(percentage: number): ContextUsageUpdate {
  const current = Math.round(percentage * 2000);
  return {
    type: 'context_usage',
    model: 'claude-opus-4-5-20251101',
    tokens: {
      current,
      max: 200000,
      percentage,
    },
    categories: [],
    timestamp: Date.now(),
  };
}

// ============================================================================
// Session Reuse Tests (AC-1)
// ============================================================================

describe('SessionLifecycleManager - Session Reuse', () => {
  let manager: SessionLifecycleManager;
  let client: ReturnType<typeof createMockACPClient>;
  let conversationStore: ReturnType<typeof createMockConversationStore>;
  let sessionStore: ReturnType<typeof createMockSessionStore>;

  beforeEach(() => {
    manager = new SessionLifecycleManager();
    client = createMockACPClient();
    conversationStore = createMockConversationStore();
    sessionStore = createMockSessionStore();
  });

  afterEach(() => {
    manager.clear();
  });

  // AC: @mem-session-lifecycle ac-1 - Existing session reused if within 70% context limit
  it('reuses existing session when within context threshold', async () => {
    const sessionKey = 'discord:dm:user123';

    // Create first session
    const result1 = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result1.isNew).toBe(true);
    expect(result1.state.acpSessionId).toBe('acp-session-1');

    // Update usage to 50% (under threshold)
    manager.updateContextUsage(sessionKey, createUsageUpdate(50));

    // Get session again - should reuse
    const result2 = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result2.isNew).toBe(false);
    expect(result2.wasRotated).toBe(false);
    expect(result2.state.acpSessionId).toBe('acp-session-1');
    expect(client.newSession).toHaveBeenCalledTimes(1); // Only called once
  });

  // AC: @mem-session-lifecycle ac-1 - Reuse when just under threshold
  it('reuses session at 69% usage (just under 70% threshold)', async () => {
    const sessionKey = 'discord:dm:user123';

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);
    manager.updateContextUsage(sessionKey, createUsageUpdate(69));

    const result = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result.isNew).toBe(false);
    expect(result.wasRotated).toBe(false);
  });

  // AC: @mem-session-lifecycle ac-1 - Reuse without usage data
  it('reuses session when no usage data available', async () => {
    const sessionKey = 'discord:dm:user123';

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);

    // Don't update usage - simulate no usage check yet
    const result = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result.isNew).toBe(false);
    expect(client.newSession).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Session Rotation Tests (AC-2)
// ============================================================================

describe('SessionLifecycleManager - Session Rotation', () => {
  let manager: SessionLifecycleManager;
  let client: ReturnType<typeof createMockACPClient>;
  let conversationStore: ReturnType<typeof createMockConversationStore>;
  let sessionStore: ReturnType<typeof createMockSessionStore>;

  beforeEach(() => {
    manager = new SessionLifecycleManager();
    client = createMockACPClient();
    conversationStore = createMockConversationStore();
    sessionStore = createMockSessionStore();
  });

  afterEach(() => {
    manager.clear();
  });

  // AC: @mem-session-lifecycle ac-2 - New session created when threshold exceeded
  it('rotates session when context exceeds 70% threshold', async () => {
    const sessionKey = 'discord:dm:user123';

    // Create first session
    const result1 = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result1.state.acpSessionId).toBe('acp-session-1');

    // Update usage to 75% (over threshold)
    manager.updateContextUsage(sessionKey, createUsageUpdate(75));

    // Get session - should rotate
    const result2 = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result2.isNew).toBe(true);
    expect(result2.wasRotated).toBe(true);
    expect(result2.state.acpSessionId).toBe('acp-session-2');
    expect(client.newSession).toHaveBeenCalledTimes(2);
  });

  // AC: @mem-session-lifecycle ac-2 - Rotate at exactly 70%
  it('rotates session at exactly 70% usage', async () => {
    const sessionKey = 'discord:dm:user123';

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);
    manager.updateContextUsage(sessionKey, createUsageUpdate(70));

    const result = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result.isNew).toBe(true);
    expect(result.wasRotated).toBe(true);
  });

  // AC: @mem-session-lifecycle ac-2 - Custom threshold
  it('respects custom rotation threshold', async () => {
    manager = new SessionLifecycleManager({ rotationThreshold: 0.50 });
    const sessionKey = 'discord:dm:user123';

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);
    manager.updateContextUsage(sessionKey, createUsageUpdate(55));

    const result = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result.wasRotated).toBe(true);
  });

  // AC: @mem-session-lifecycle ac-2 - Emits rotation event
  it('emits session:rotated event on rotation', async () => {
    const sessionKey = 'discord:dm:user123';
    const rotatedHandler = vi.fn();
    manager.on('session:rotated', rotatedHandler);

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);
    manager.updateContextUsage(sessionKey, createUsageUpdate(80));

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);

    expect(rotatedHandler).toHaveBeenCalledWith({
      sessionKey,
      oldSessionId: 'acp-session-1',
      newState: expect.objectContaining({
        acpSessionId: 'acp-session-2',
      }),
    });
  });
});

// ============================================================================
// Restart Recovery Tests (AC-3, AC-9)
// ============================================================================

describe('SessionLifecycleManager - Restart Recovery', () => {
  let manager: SessionLifecycleManager;
  let client: ReturnType<typeof createMockACPClient>;
  let conversationStore: ReturnType<typeof createMockConversationStore>;
  let sessionStore: ReturnType<typeof createMockSessionStore>;

  beforeEach(() => {
    manager = new SessionLifecycleManager();
    client = createMockACPClient();
    conversationStore = createMockConversationStore();
    sessionStore = createMockSessionStore();
  });

  afterEach(() => {
    manager.clear();
  });

  // AC: @mem-session-lifecycle ac-3 - New session created on restart with context restoration
  it('creates new session on restart for known session key', async () => {
    const sessionKey = 'discord:dm:user123';

    // Simulate existing conversation from previous run
    conversationStore.conversations.set(sessionKey, {
      id: 'conv-123',
      updated_at: new Date().toISOString(), // Recent
    });

    // New manager (simulating restart) - no in-memory session
    const result = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result.isNew).toBe(true);
    expect(result.state.conversationId).toBe('conv-123');
    expect(client.newSession).toHaveBeenCalledTimes(1);
  });

  // AC: @mem-session-lifecycle ac-9 - Rebuild state from ConversationStore for recent conversation
  it('emits session:recovered for recent conversation', async () => {
    const sessionKey = 'discord:dm:user123';
    const recoveredHandler = vi.fn();
    manager.on('session:recovered', recoveredHandler);

    // Recent conversation (within 30 min)
    conversationStore.conversations.set(sessionKey, {
      id: 'conv-recent',
      updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
    });

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);

    expect(recoveredHandler).toHaveBeenCalledWith({
      sessionKey,
      state: expect.objectContaining({
        conversationId: 'conv-recent',
      }),
      fromConversationId: 'conv-recent',
    });
  });

  // AC: @mem-session-lifecycle ac-9 - Don't trigger recovery for stale conversations
  it('creates normal session for stale conversation (> 30 min)', async () => {
    manager = new SessionLifecycleManager({ recentConversationMaxAgeMs: 30 * 60 * 1000 });
    const sessionKey = 'discord:dm:user123';
    const recoveredHandler = vi.fn();
    const createdHandler = vi.fn();
    manager.on('session:recovered', recoveredHandler);
    manager.on('session:created', createdHandler);

    // Stale conversation (over 30 min)
    conversationStore.conversations.set(sessionKey, {
      id: 'conv-stale',
      updated_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(), // 45 min ago
    });

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);

    expect(recoveredHandler).not.toHaveBeenCalled();
    expect(createdHandler).toHaveBeenCalled();
  });

  // AC: @mem-session-lifecycle ac-3 - New session for unknown session key
  it('creates new session for unknown session key', async () => {
    const sessionKey = 'discord:dm:newuser';
    const createdHandler = vi.fn();
    manager.on('session:created', createdHandler);

    const result = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result.isNew).toBe(true);
    expect(result.state.conversationId).toBe(''); // No conversation yet
    expect(createdHandler).toHaveBeenCalled();
  });
});

// ============================================================================
// Session Completion Tests (AC-4)
// ============================================================================

describe('SessionLifecycleManager - Session Completion', () => {
  let manager: SessionLifecycleManager;
  let client: ReturnType<typeof createMockACPClient>;
  let conversationStore: ReturnType<typeof createMockConversationStore>;
  let sessionStore: ReturnType<typeof createMockSessionStore>;

  beforeEach(() => {
    manager = new SessionLifecycleManager();
    client = createMockACPClient();
    conversationStore = createMockConversationStore();
    sessionStore = createMockSessionStore();
  });

  afterEach(() => {
    manager.clear();
  });

  // AC: @mem-session-lifecycle ac-4 - Previous session marked completed on rotation
  it('marks previous session as complete when rotating', async () => {
    const sessionKey = 'discord:dm:user123';

    // Create first session with conversation
    const result1 = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );
    manager.setConversationId(sessionKey, 'conv-123');

    // Trigger rotation
    manager.updateContextUsage(sessionKey, createUsageUpdate(80));
    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);

    expect(sessionStore.completeSession).toHaveBeenCalledWith('acp-session-1');
  });

  // AC: @mem-session-lifecycle ac-4 - Handles completion errors gracefully
  it('continues even if session completion fails', async () => {
    const sessionKey = 'discord:dm:user123';

    // Mock completeSession to throw
    sessionStore.completeSession = vi.fn().mockRejectedValue(new Error('DB error'));

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);
    manager.setConversationId(sessionKey, 'conv-123');
    manager.updateContextUsage(sessionKey, createUsageUpdate(80));

    // Should not throw
    const result = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );

    expect(result.wasRotated).toBe(true);
    expect(result.state.acpSessionId).toBe('acp-session-2');
  });
});

// ============================================================================
// Context Usage Integration Tests (AC-5, AC-6, AC-7)
// ============================================================================

describe('SessionLifecycleManager - Context Usage', () => {
  let manager: SessionLifecycleManager;
  let client: ReturnType<typeof createMockACPClient>;
  let conversationStore: ReturnType<typeof createMockConversationStore>;
  let sessionStore: ReturnType<typeof createMockSessionStore>;

  beforeEach(() => {
    manager = new SessionLifecycleManager();
    client = createMockACPClient();
    conversationStore = createMockConversationStore();
    sessionStore = createMockSessionStore();
  });

  afterEach(() => {
    manager.clear();
  });

  // AC: @mem-session-lifecycle ac-6 - Receives ContextUsageUpdate with token counts
  it('stores and retrieves context usage updates', async () => {
    const sessionKey = 'discord:dm:user123';

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);

    const usage = createUsageUpdate(45);
    manager.updateContextUsage(sessionKey, usage);

    const session = manager.getSession(sessionKey);
    expect(session?.lastUsage).toEqual(usage);
  });

  // AC: @mem-session-lifecycle ac-6 - Emits usage:updated event
  it('emits usage:updated event when usage is updated', async () => {
    const sessionKey = 'discord:dm:user123';
    const usageHandler = vi.fn();
    manager.on('usage:updated', usageHandler);

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);

    const usage = createUsageUpdate(50);
    manager.updateContextUsage(sessionKey, usage);

    expect(usageHandler).toHaveBeenCalledWith({
      sessionKey,
      usage,
    });
  });

  // AC: @mem-session-lifecycle ac-7 - Session continues with stale usage data
  it('continues with stale data when no usage update available', async () => {
    const sessionKey = 'discord:dm:user123';

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);

    // Update usage once
    const oldUsage = createUsageUpdate(40);
    manager.updateContextUsage(sessionKey, oldUsage);

    // Don't update again - simulating failed usage check
    // Session should still be usable with old data
    const session = manager.getSession(sessionKey);
    expect(session?.lastUsage).toEqual(oldUsage);

    // Session still under threshold, should reuse
    const result = await manager.getOrCreateSession(
      sessionKey,
      client,
      conversationStore,
      sessionStore
    );
    expect(result.isNew).toBe(false);
  });

  // AC: @mem-session-lifecycle ac-7 - Ignores usage update for unknown session
  it('ignores usage update for unknown session', () => {
    const usageHandler = vi.fn();
    manager.on('usage:updated', usageHandler);

    // Update usage for session that doesn't exist
    manager.updateContextUsage('unknown-session', createUsageUpdate(50));

    expect(usageHandler).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Per-Key Locking Tests (AC-8)
// ============================================================================

describe('SessionLifecycleManager - Per-Key Locking', () => {
  let manager: SessionLifecycleManager;

  beforeEach(() => {
    manager = new SessionLifecycleManager();
  });

  afterEach(() => {
    manager.clear();
  });

  // AC: @mem-session-lifecycle ac-8 - Messages serialized via per-key lock
  it('serializes concurrent operations on same session key', async () => {
    const sessionKey = 'discord:dm:user123';
    const executionOrder: number[] = [];

    // Start two concurrent operations
    const op1 = manager.withLock(sessionKey, async () => {
      executionOrder.push(1);
      await new Promise((r) => setTimeout(r, 50)); // Simulate work
      executionOrder.push(2);
      return 'op1';
    });

    const op2 = manager.withLock(sessionKey, async () => {
      executionOrder.push(3);
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push(4);
      return 'op2';
    });

    const [result1, result2] = await Promise.all([op1, op2]);

    expect(result1).toBe('op1');
    expect(result2).toBe('op2');
    // Operations should be serialized: op1 completes before op2 starts
    expect(executionOrder).toEqual([1, 2, 3, 4]);
  });

  // AC: @mem-session-lifecycle ac-8 - Different session keys can run concurrently
  it('allows concurrent operations on different session keys', async () => {
    const sessionKey1 = 'discord:dm:user1';
    const sessionKey2 = 'discord:dm:user2';
    const executionOrder: string[] = [];

    const op1 = manager.withLock(sessionKey1, async () => {
      executionOrder.push('1-start');
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push('1-end');
      return 'op1';
    });

    const op2 = manager.withLock(sessionKey2, async () => {
      executionOrder.push('2-start');
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push('2-end');
      return 'op2';
    });

    await Promise.all([op1, op2]);

    // Both should start before either completes (parallel execution)
    expect(executionOrder[0]).toBe('1-start');
    expect(executionOrder[1]).toBe('2-start');
  });

  // AC: @mem-session-lifecycle ac-8 - Lock released on error
  it('releases lock even when operation throws', async () => {
    const sessionKey = 'discord:dm:user123';

    // First operation throws
    await expect(
      manager.withLock(sessionKey, async () => {
        throw new Error('Test error');
      })
    ).rejects.toThrow('Test error');

    // Second operation should still work
    const result = await manager.withLock(sessionKey, async () => {
      return 'success';
    });

    expect(result).toBe('success');
  });

  // AC: @mem-session-lifecycle ac-8 - Multiple queued operations
  it('handles multiple queued operations', async () => {
    const sessionKey = 'discord:dm:user123';
    const results: number[] = [];

    const operations = [1, 2, 3, 4, 5].map((n) =>
      manager.withLock(sessionKey, async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(n);
        return n;
      })
    );

    const returnValues = await Promise.all(operations);

    expect(returnValues).toEqual([1, 2, 3, 4, 5]);
    expect(results).toEqual([1, 2, 3, 4, 5]); // Executed in order
  });
});

// ============================================================================
// Session State Management Tests
// ============================================================================

describe('SessionLifecycleManager - State Management', () => {
  let manager: SessionLifecycleManager;
  let client: ReturnType<typeof createMockACPClient>;
  let conversationStore: ReturnType<typeof createMockConversationStore>;
  let sessionStore: ReturnType<typeof createMockSessionStore>;

  beforeEach(() => {
    manager = new SessionLifecycleManager();
    client = createMockACPClient();
    conversationStore = createMockConversationStore();
    sessionStore = createMockSessionStore();
  });

  afterEach(() => {
    manager.clear();
  });

  it('tracks multiple sessions independently', async () => {
    const sessionKey1 = 'discord:dm:user1';
    const sessionKey2 = 'discord:dm:user2';

    await manager.getOrCreateSession(sessionKey1, client, conversationStore, sessionStore);
    await manager.getOrCreateSession(sessionKey2, client, conversationStore, sessionStore);

    expect(manager.getAllSessions()).toHaveLength(2);
    expect(manager.getSession(sessionKey1)?.acpSessionId).toBe('acp-session-1');
    expect(manager.getSession(sessionKey2)?.acpSessionId).toBe('acp-session-2');
  });

  it('ends session and removes from tracking', async () => {
    const sessionKey = 'discord:dm:user123';
    const endedHandler = vi.fn();
    manager.on('session:ended', endedHandler);

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);
    manager.endSession(sessionKey);

    expect(manager.getSession(sessionKey)).toBeUndefined();
    expect(endedHandler).toHaveBeenCalledWith({
      sessionKey,
      sessionId: 'acp-session-1',
    });
  });

  it('updates conversation ID for session', async () => {
    const sessionKey = 'discord:dm:user123';

    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);

    manager.setConversationId(sessionKey, 'conv-123');

    const session = manager.getSession(sessionKey);
    expect(session?.conversationId).toBe('conv-123');
  });

  it('clears all sessions', async () => {
    await manager.getOrCreateSession('key1', client, conversationStore, sessionStore);
    await manager.getOrCreateSession('key2', client, conversationStore, sessionStore);

    expect(manager.getAllSessions()).toHaveLength(2);

    manager.clear();

    expect(manager.getAllSessions()).toHaveLength(0);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('SessionLifecycleManager - Edge Cases', () => {
  let manager: SessionLifecycleManager;
  let client: ReturnType<typeof createMockACPClient>;
  let conversationStore: ReturnType<typeof createMockConversationStore>;
  let sessionStore: ReturnType<typeof createMockSessionStore>;

  beforeEach(() => {
    manager = new SessionLifecycleManager();
    client = createMockACPClient();
    conversationStore = createMockConversationStore();
    sessionStore = createMockSessionStore();
  });

  afterEach(() => {
    manager.clear();
  });

  it('handles rapid rotation cycles', async () => {
    const sessionKey = 'discord:dm:user123';

    // Create session and immediately trigger rotation multiple times
    await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);
    manager.setConversationId(sessionKey, 'conv-123');

    for (let i = 0; i < 5; i++) {
      manager.updateContextUsage(sessionKey, createUsageUpdate(80));
      await manager.getOrCreateSession(sessionKey, client, conversationStore, sessionStore);
    }

    // Should have 6 sessions total (1 original + 5 rotations)
    expect(client.newSession).toHaveBeenCalledTimes(6);
    expect(manager.getSession(sessionKey)?.acpSessionId).toBe('acp-session-6');
  });

  it('handles shouldRotateSession for non-existent session', () => {
    expect(manager.shouldRotateSession('non-existent')).toBe(false);
  });

  it('handles endSession for non-existent session', () => {
    const endedHandler = vi.fn();
    manager.on('session:ended', endedHandler);

    // Should not throw
    manager.endSession('non-existent');

    expect(endedHandler).not.toHaveBeenCalled();
  });

  it('handles setConversationId for non-existent session', () => {
    // Should not throw
    manager.setConversationId('non-existent', 'conv-123');

    expect(manager.getSession('non-existent')).toBeUndefined();
  });
});
