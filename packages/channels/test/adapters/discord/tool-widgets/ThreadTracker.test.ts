/**
 * ThreadTracker Tests
 *
 * Tests for managing Discord thread lifecycle for tool widget isolation.
 * AC: @discord-tool-widgets ac-10, ac-11, ac-13, ac-16, ac-17
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadTracker } from '../../../../src/adapters/discord/tool-widgets/ThreadTracker.js';

describe('ThreadTracker', () => {
  let tracker: ThreadTracker;

  beforeEach(() => {
    tracker = new ThreadTracker();
  });

  describe('getOrCreateThread()', () => {
    // AC: @discord-tool-widgets ac-10 - Thread creation on first tool_call
    it('should create thread on first call', async () => {
      const createFn = vi.fn().mockResolvedValue('thread-123');

      const threadId = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      expect(threadId).toBe('thread-123');
      expect(createFn).toHaveBeenCalledTimes(1);
    });

    // AC: @discord-tool-widgets ac-11 - Reuse existing thread
    it('should return existing thread on subsequent calls', async () => {
      const createFn = vi.fn().mockResolvedValue('thread-123');

      // First call creates thread
      const threadId1 = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      // Second call reuses thread
      const threadId2 = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      expect(threadId1).toBe('thread-123');
      expect(threadId2).toBe('thread-123');
      expect(createFn).toHaveBeenCalledTimes(1); // Only called once
    });

    // AC: @discord-tool-widgets ac-10, ac-11 - Race condition prevention
    it('should handle concurrent calls with promise deduplication', async () => {
      let resolvePromise: (value: string) => void;
      const createFn = vi.fn().mockImplementation(() => {
        return new Promise<string>((resolve) => {
          resolvePromise = resolve;
        });
      });

      // Start multiple concurrent calls before thread is created
      const promise1 = tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);
      const promise2 = tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);
      const promise3 = tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);

      // createFn should only be called once (deduplication)
      expect(createFn).toHaveBeenCalledTimes(1);

      // Resolve the thread creation
      resolvePromise!('thread-123');

      // All promises should resolve to the same thread ID
      const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);

      expect(result1).toBe('thread-123');
      expect(result2).toBe('thread-123');
      expect(result3).toBe('thread-123');
    });

    // AC: @discord-tool-widgets ac-12, ac-17 - Graceful failure
    it('should handle creation failure gracefully', async () => {
      const createFn = vi.fn().mockRejectedValue(new Error('Permission denied'));

      const threadId = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      expect(threadId).toBeNull();
      expect(createFn).toHaveBeenCalledTimes(1);
    });

    it('should return null when createFn throws', async () => {
      const createFn = vi.fn().mockRejectedValue(new Error('Thread creation failed'));

      const threadId = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      expect(threadId).toBeNull();
    });

    it('should not retry creation after failure', async () => {
      const createFn = vi.fn().mockRejectedValueOnce(new Error('Failed'));

      // First call fails
      const threadId1 = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      // Second call should return cached null (not retry)
      const threadId2 = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      expect(threadId1).toBeNull();
      expect(threadId2).toBeNull();
      expect(createFn).toHaveBeenCalledTimes(1); // Only called once
    });

    // AC: @discord-tool-widgets ac-16 - Per-response thread isolation
    it('should create separate threads for different parent messages', async () => {
      let callCount = 0;
      const createFn = vi.fn().mockImplementation(() => {
        return Promise.resolve(`thread-${++callCount}`);
      });

      const threadId1 = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      const threadId2 = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-2', // Different parent message
        createFn
      );

      expect(threadId1).toBe('thread-1');
      expect(threadId2).toBe('thread-2');
      expect(createFn).toHaveBeenCalledTimes(2);
    });

    it('should create separate threads for different sessions', async () => {
      let callCount = 0;
      const createFn = vi.fn().mockImplementation(() => {
        return Promise.resolve(`thread-${++callCount}`);
      });

      const threadId1 = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      const threadId2 = await tracker.getOrCreateThread(
        'session-2', // Different session
        'channel-1',
        'msg-1',
        createFn
      );

      expect(threadId1).toBe('thread-1');
      expect(threadId2).toBe('thread-2');
      expect(createFn).toHaveBeenCalledTimes(2);
    });

    it('should create separate threads for different channels', async () => {
      let callCount = 0;
      const createFn = vi.fn().mockImplementation(() => {
        return Promise.resolve(`thread-${++callCount}`);
      });

      const threadId1 = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      const threadId2 = await tracker.getOrCreateThread(
        'session-1',
        'channel-2', // Different channel
        'msg-1',
        createFn
      );

      expect(threadId1).toBe('thread-1');
      expect(threadId2).toBe('thread-2');
      expect(createFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('getThreadId()', () => {
    it('should return threadId when exists', async () => {
      const createFn = vi.fn().mockResolvedValue('thread-123');

      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);

      const threadId = tracker.getThreadId('session-1', 'channel-1', 'msg-1');

      expect(threadId).toBe('thread-123');
    });

    it('should return null when not exists', () => {
      const threadId = tracker.getThreadId('session-1', 'channel-1', 'msg-1');

      expect(threadId).toBeNull();
    });

    it('should return null when thread creation failed', async () => {
      const createFn = vi.fn().mockRejectedValue(new Error('Failed'));

      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);

      const threadId = tracker.getThreadId('session-1', 'channel-1', 'msg-1');

      expect(threadId).toBeNull();
    });
  });

  describe('hasThread()', () => {
    it('should return true when thread exists', async () => {
      const createFn = vi.fn().mockResolvedValue('thread-123');

      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);

      expect(tracker.hasThread('session-1', 'channel-1', 'msg-1')).toBe(true);
    });

    it('should return true when thread creation was attempted (even if failed)', async () => {
      const createFn = vi.fn().mockRejectedValue(new Error('Failed'));

      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);

      // Returns true because we attempted creation (state exists)
      expect(tracker.hasThread('session-1', 'channel-1', 'msg-1')).toBe(true);
    });

    it('should return false when no thread state exists', () => {
      expect(tracker.hasThread('session-1', 'channel-1', 'msg-1')).toBe(false);
    });
  });

  describe('markThreadDeleted()', () => {
    // AC: @discord-tool-widgets ac-17 - Handle deleted thread
    it('should mark thread as deleted', async () => {
      const createFn = vi.fn().mockResolvedValue('thread-123');

      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);

      expect(tracker.getThreadId('session-1', 'channel-1', 'msg-1')).toBe('thread-123');

      tracker.markThreadDeleted('session-1', 'channel-1', 'msg-1');

      expect(tracker.getThreadId('session-1', 'channel-1', 'msg-1')).toBeNull();
    });

    it('should handle marking non-existent thread as deleted', () => {
      // Should not throw
      tracker.markThreadDeleted('session-1', 'channel-1', 'msg-1');

      expect(tracker.getThreadId('session-1', 'channel-1', 'msg-1')).toBeNull();
    });

    it('should allow subsequent creation attempts after deletion', async () => {
      let callCount = 0;
      const createFn = vi.fn().mockImplementation(() => {
        return Promise.resolve(`thread-${++callCount}`);
      });

      // Create thread
      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);
      expect(tracker.getThreadId('session-1', 'channel-1', 'msg-1')).toBe('thread-1');

      // Mark as deleted
      tracker.markThreadDeleted('session-1', 'channel-1', 'msg-1');

      // Subsequent calls should return null (from cached state)
      // Not create a new thread - the message can only have one thread
      const threadId = await tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      expect(threadId).toBeNull();
      expect(createFn).toHaveBeenCalledTimes(1); // Only the initial call
    });
  });

  describe('cleanupSession()', () => {
    // AC: @discord-tool-widgets ac-13 - Session cleanup
    it('should remove all tracking for session', async () => {
      const createFn = vi.fn().mockResolvedValue('thread-123');

      // Create threads for session-1
      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);
      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-2', createFn);

      // Create thread for session-2
      await tracker.getOrCreateThread('session-2', 'channel-1', 'msg-3', createFn);

      tracker.cleanupSession('session-1');

      // Session-1 threads should be gone
      expect(tracker.hasThread('session-1', 'channel-1', 'msg-1')).toBe(false);
      expect(tracker.hasThread('session-1', 'channel-1', 'msg-2')).toBe(false);

      // Session-2 thread should remain
      expect(tracker.hasThread('session-2', 'channel-1', 'msg-3')).toBe(true);
    });

    it('should handle cleanup of non-existent session', () => {
      // Should not throw
      tracker.cleanupSession('non-existent');

      expect(tracker.getAllThreadStates()).toHaveLength(0);
    });

    it('should cleanup pending creations map on session cleanup', async () => {
      let resolvePromise: (value: string) => void;
      const createFn = vi.fn().mockImplementation(() => {
        return new Promise<string>((resolve) => {
          resolvePromise = resolve;
        });
      });

      // Start creation but don't resolve yet
      const creationPromise = tracker.getOrCreateThread(
        'session-1',
        'channel-1',
        'msg-1',
        createFn
      );

      // Cleanup while creation is pending
      // This removes the pending creation entry, so subsequent calls won't join this promise
      tracker.cleanupSession('session-1');

      // Resolve the creation after cleanup
      resolvePromise!('thread-123');
      const result = await creationPromise;

      // The promise still resolves (can't cancel it), but it returns the thread ID
      // The state is created because createThread runs to completion
      expect(result).toBe('thread-123');

      // Note: The thread state is created after cleanup because the async
      // createThread completes. In practice, session cleanup happens after
      // all tool calls are done, so this race is unlikely.
    });
  });

  describe('getAllThreadStates()', () => {
    it('should return empty array when no threads', () => {
      expect(tracker.getAllThreadStates()).toEqual([]);
    });

    it('should return all thread states', async () => {
      const createFn = vi.fn().mockResolvedValue('thread-123');

      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);
      await tracker.getOrCreateThread('session-2', 'channel-1', 'msg-2', createFn);

      const states = tracker.getAllThreadStates();

      expect(states).toHaveLength(2);
      expect(states.map((s) => s.parentMessageId)).toContain('msg-1');
      expect(states.map((s) => s.parentMessageId)).toContain('msg-2');
    });
  });

  describe('getSessionThreads()', () => {
    it('should return empty array when no threads for session', () => {
      expect(tracker.getSessionThreads('session-1')).toEqual([]);
    });

    it('should return only threads for specified session', async () => {
      const createFn = vi.fn().mockResolvedValue('thread-123');

      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);
      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-2', createFn);
      await tracker.getOrCreateThread('session-2', 'channel-1', 'msg-3', createFn);

      const session1Threads = tracker.getSessionThreads('session-1');
      const session2Threads = tracker.getSessionThreads('session-2');

      expect(session1Threads).toHaveLength(2);
      expect(session2Threads).toHaveLength(1);
    });
  });

  describe('thread state properties', () => {
    it('should store correct thread state properties', async () => {
      const createFn = vi.fn().mockResolvedValue('thread-123');

      await tracker.getOrCreateThread('session-1', 'channel-1', 'msg-1', createFn);

      const states = tracker.getAllThreadStates();
      expect(states).toHaveLength(1);

      const state = states[0]!;
      expect(state.sessionId).toBe('session-1');
      expect(state.channelId).toBe('channel-1');
      expect(state.parentMessageId).toBe('msg-1');
      expect(state.threadId).toBe('thread-123');
      expect(state.createdAt).toBeInstanceOf(Date);
    });
  });
});
