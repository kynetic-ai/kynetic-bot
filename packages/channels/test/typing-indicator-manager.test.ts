/**
 * TypingIndicatorManager Tests
 *
 * Test coverage for typing indicator refresh loop management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TypingIndicatorManager } from '../src/typing-indicator-manager.js';

/**
 * Delay helper for testing
 */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('TypingIndicatorManager', () => {
  let manager: TypingIndicatorManager;
  let sendFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TypingIndicatorManager({
      refreshInterval: 8000,
      maxDuration: 60000,
    });
    sendFn = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Basic Operations', () => {
    it('should send typing indicator immediately on start', async () => {
      await manager.startTyping('channel-1', 'msg-1', sendFn);

      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('should refresh typing indicator at configured interval', async () => {
      await manager.startTyping('channel-1', 'msg-1', sendFn);

      // Initial call
      expect(sendFn).toHaveBeenCalledTimes(1);

      // Advance 8 seconds - should trigger refresh
      await vi.advanceTimersByTimeAsync(8000);
      expect(sendFn).toHaveBeenCalledTimes(2);

      // Advance another 8 seconds
      await vi.advanceTimersByTimeAsync(8000);
      expect(sendFn).toHaveBeenCalledTimes(3);
    });

    it('should stop refreshing when stopped', async () => {
      await manager.startTyping('channel-1', 'msg-1', sendFn);

      expect(sendFn).toHaveBeenCalledTimes(1);

      // Stop typing
      manager.stopTyping('channel-1');

      // Advance time - should not trigger more calls
      await vi.advanceTimersByTimeAsync(8000);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('should track active status correctly', async () => {
      expect(manager.isActive('channel-1')).toBe(false);

      await manager.startTyping('channel-1', 'msg-1', sendFn);

      expect(manager.isActive('channel-1')).toBe(true);

      manager.stopTyping('channel-1');
      expect(manager.isActive('channel-1')).toBe(false);
    });
  });

  describe('Duplicate Prevention', () => {
    it('should not start duplicate loops for same channel', async () => {
      await manager.startTyping('channel-1', 'msg-1', sendFn);

      expect(sendFn).toHaveBeenCalledTimes(1);

      // Try to start again for same channel
      const sendFn2 = vi.fn().mockResolvedValue(undefined);
      await manager.startTyping('channel-1', 'msg-2', sendFn2);

      // Second sendFn should not be called
      expect(sendFn2).toHaveBeenCalledTimes(0);
      // Original should still be only called once
      expect(sendFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('Multiple Channels', () => {
    it('should handle multiple concurrent channels independently', async () => {
      const sendFn1 = vi.fn().mockResolvedValue(undefined);
      const sendFn2 = vi.fn().mockResolvedValue(undefined);

      await Promise.all([
        manager.startTyping('channel-1', 'msg-1', sendFn1),
        manager.startTyping('channel-2', 'msg-2', sendFn2),
      ]);

      expect(sendFn1).toHaveBeenCalledTimes(1);
      expect(sendFn2).toHaveBeenCalledTimes(1);
      expect(manager.getActiveCount()).toBe(2);

      // Advance time
      await vi.advanceTimersByTimeAsync(8000);
      expect(sendFn1).toHaveBeenCalledTimes(2);
      expect(sendFn2).toHaveBeenCalledTimes(2);

      // Stop one channel
      manager.stopTyping('channel-1');
      expect(manager.getActiveCount()).toBe(1);

      // Advance time - only channel-2 should refresh
      await vi.advanceTimersByTimeAsync(8000);
      expect(sendFn1).toHaveBeenCalledTimes(2); // Stopped
      expect(sendFn2).toHaveBeenCalledTimes(3); // Still running
    });
  });

  describe('Safety Timeout', () => {
    it('should stop typing loop after max duration', async () => {
      await manager.startTyping('channel-1', 'msg-1', sendFn);

      expect(sendFn).toHaveBeenCalledTimes(1);
      expect(manager.isActive('channel-1')).toBe(true);

      // Advance to just before timeout (56 seconds = 7 intervals)
      await vi.advanceTimersByTimeAsync(56000);
      expect(manager.isActive('channel-1')).toBe(true);

      // Advance past timeout (64 seconds total, 8th interval check triggers timeout)
      await vi.advanceTimersByTimeAsync(8000);
      expect(manager.isActive('channel-1')).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should continue loop if sendFn throws error', async () => {
      const failingSendFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue(undefined);

      await manager.startTyping('channel-1', 'msg-1', failingSendFn);

      // First call failed but was caught
      expect(failingSendFn).toHaveBeenCalledTimes(1);

      // Loop should continue
      await vi.advanceTimersByTimeAsync(8000);
      expect(failingSendFn).toHaveBeenCalledTimes(2);

      // Subsequent calls succeed
      expect(manager.isActive('channel-1')).toBe(true);
    });

    it('should handle initial sendFn error gracefully', async () => {
      const failingSendFn = vi.fn().mockRejectedValue(new Error('Initial error'));

      await manager.startTyping('channel-1', 'msg-1', failingSendFn);

      // Loop should still be created despite initial error
      expect(manager.isActive('channel-1')).toBe(true);
    });
  });

  describe('Cleanup', () => {
    it('should stop all active loops', async () => {
      const sendFn1 = vi.fn().mockResolvedValue(undefined);
      const sendFn2 = vi.fn().mockResolvedValue(undefined);
      const sendFn3 = vi.fn().mockResolvedValue(undefined);

      await Promise.all([
        manager.startTyping('channel-1', 'msg-1', sendFn1),
        manager.startTyping('channel-2', 'msg-2', sendFn2),
        manager.startTyping('channel-3', 'msg-3', sendFn3),
      ]);

      expect(manager.getActiveCount()).toBe(3);

      manager.stopAll();

      expect(manager.getActiveCount()).toBe(0);
      expect(manager.isActive('channel-1')).toBe(false);
      expect(manager.isActive('channel-2')).toBe(false);
      expect(manager.isActive('channel-3')).toBe(false);

      // Advance time - no more calls should happen
      const call1Count = sendFn1.mock.calls.length;
      const call2Count = sendFn2.mock.calls.length;
      const call3Count = sendFn3.mock.calls.length;

      await vi.advanceTimersByTimeAsync(8000);

      expect(sendFn1).toHaveBeenCalledTimes(call1Count);
      expect(sendFn2).toHaveBeenCalledTimes(call2Count);
      expect(sendFn3).toHaveBeenCalledTimes(call3Count);
    });

    it('should handle stop on non-existent channel gracefully', () => {
      expect(() => manager.stopTyping('non-existent')).not.toThrow();
    });
  });

  describe('Custom Configuration', () => {
    it('should use custom refresh interval', async () => {
      const customManager = new TypingIndicatorManager({
        refreshInterval: 5000,
        maxDuration: 60000,
      });
      const customSendFn = vi.fn().mockResolvedValue(undefined);

      await customManager.startTyping('channel-1', 'msg-1', customSendFn);

      expect(customSendFn).toHaveBeenCalledTimes(1);

      // Should refresh at 5 seconds, not 8
      await vi.advanceTimersByTimeAsync(5000);
      expect(customSendFn).toHaveBeenCalledTimes(2);
    });

    it('should use custom max duration', async () => {
      const customManager = new TypingIndicatorManager({
        refreshInterval: 8000,
        maxDuration: 20000,
      });
      const customSendFn = vi.fn().mockResolvedValue(undefined);

      await customManager.startTyping('channel-1', 'msg-1', customSendFn);

      expect(customManager.isActive('channel-1')).toBe(true);

      // Advance to just before custom timeout (16 seconds = 2 intervals)
      await vi.advanceTimersByTimeAsync(16000);
      expect(customManager.isActive('channel-1')).toBe(true);

      // Advance past custom timeout (24 seconds total, 3rd interval check triggers timeout)
      await vi.advanceTimersByTimeAsync(8000);
      expect(customManager.isActive('channel-1')).toBe(false);
    });
  });
});
