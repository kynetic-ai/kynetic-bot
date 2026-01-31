/**
 * MessageUpdateBatcher Tests
 *
 * Tests for rate-limited Discord message edit batcher.
 * AC: @discord-tool-widgets ac-5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EmbedBuilder, ActionRowBuilder, ButtonBuilder, Message } from 'discord.js';
import {
  MessageUpdateBatcher,
  type MessageEditFn,
} from '../../../../src/adapters/discord/tool-widgets/MessageUpdateBatcher.js';

/**
 * Create a mock message edit function
 */
function createMockEditFn() {
  return vi.fn<MessageEditFn>().mockResolvedValue({ id: 'msg-123' } as Message);
}

/**
 * Create mock embeds
 */
function createMockEmbeds(count = 1): EmbedBuilder[] {
  return Array(count).fill({ toJSON: () => ({}) } as unknown as EmbedBuilder);
}

/**
 * Create mock components
 */
function createMockComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [{ toJSON: () => ({}) } as unknown as ActionRowBuilder<ButtonBuilder>];
}

describe('MessageUpdateBatcher', () => {
  let batcher: MessageUpdateBatcher;
  let editFn: ReturnType<typeof createMockEditFn>;

  beforeEach(() => {
    vi.useFakeTimers();
    editFn = createMockEditFn();
    batcher = new MessageUpdateBatcher(editFn);
  });

  afterEach(() => {
    batcher.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default state', () => {
      expect(batcher.getQueueSize()).toBe(0);
      expect(batcher.getTokens()).toBe(5); // TOKENS_MAX
    });
  });

  describe('queueUpdate()', () => {
    it('should queue an update', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      await batcher.queueUpdate('msg-1', 'channel-1', embeds, components);

      expect(batcher.getQueueSize()).toBe(1);
    });

    it('should replace existing update for same message (batching)', async () => {
      const embeds1 = createMockEmbeds();
      const embeds2 = createMockEmbeds(2);
      const components = createMockComponents();

      await batcher.queueUpdate('msg-1', 'channel-1', embeds1, components);
      await batcher.queueUpdate('msg-1', 'channel-1', embeds2, components);

      expect(batcher.getQueueSize()).toBe(1);
    });

    it('should queue multiple updates for different messages', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      await batcher.queueUpdate('msg-1', 'channel-1', embeds, components);
      await batcher.queueUpdate('msg-2', 'channel-1', embeds, components);
      await batcher.queueUpdate('msg-3', 'channel-1', embeds, components);

      expect(batcher.getQueueSize()).toBe(3);
    });

    // AC: @discord-tool-widgets ac-5 - Rate limiting
    it('should drop updates when queue size limit is reached', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      // Fill queue to MAX_QUEUE_SIZE (50)
      for (let i = 0; i < 50; i++) {
        await batcher.queueUpdate(`msg-${i}`, 'channel-1', embeds, components);
      }

      expect(batcher.getQueueSize()).toBe(50);

      // This should be dropped
      await batcher.queueUpdate('msg-new', 'channel-1', embeds, components);

      expect(batcher.getQueueSize()).toBe(50);
    });

    it('should allow update for existing message even when queue is full', async () => {
      const embeds = createMockEmbeds();
      const newEmbeds = createMockEmbeds(2);
      const components = createMockComponents();

      // Fill queue to MAX_QUEUE_SIZE
      for (let i = 0; i < 50; i++) {
        await batcher.queueUpdate(`msg-${i}`, 'channel-1', embeds, components);
      }

      // Update existing message should work
      await batcher.queueUpdate('msg-0', 'channel-1', newEmbeds, components);

      expect(batcher.getQueueSize()).toBe(50);
    });
  });

  describe('flush behavior', () => {
    it('should flush after debounce period', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      await batcher.queueUpdate('msg-1', 'channel-1', embeds, components);

      expect(editFn).not.toHaveBeenCalled();

      // Advance past debounce (200ms)
      await vi.advanceTimersByTimeAsync(250);

      expect(editFn).toHaveBeenCalledTimes(1);
      expect(editFn).toHaveBeenCalledWith('channel-1', 'msg-1', embeds, components);
    });

    it('should batch rapid updates within debounce window', async () => {
      const embeds1 = createMockEmbeds();
      const embeds2 = createMockEmbeds(2);
      const components = createMockComponents();

      await batcher.queueUpdate('msg-1', 'channel-1', embeds1, components);
      await vi.advanceTimersByTimeAsync(100); // 100ms < 200ms debounce
      await batcher.queueUpdate('msg-1', 'channel-1', embeds2, components);

      await vi.advanceTimersByTimeAsync(250);

      // Should only send once with latest embeds
      expect(editFn).toHaveBeenCalledTimes(1);
      expect(editFn).toHaveBeenCalledWith('channel-1', 'msg-1', embeds2, components);
    });

    it('should process multiple queued updates', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      await batcher.queueUpdate('msg-1', 'channel-1', embeds, components);
      await batcher.queueUpdate('msg-2', 'channel-1', embeds, components);
      await batcher.queueUpdate('msg-3', 'channel-1', embeds, components);

      await vi.advanceTimersByTimeAsync(250);

      expect(editFn).toHaveBeenCalledTimes(3);
    });
  });

  describe('token bucket rate limiting', () => {
    it('should consume tokens when sending', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      await batcher.queueUpdate('msg-1', 'channel-1', embeds, components);
      await vi.advanceTimersByTimeAsync(250);

      expect(batcher.getTokens()).toBe(4); // 5 - 1
    });

    it('should rate limit when tokens exhausted', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      // Queue 6 updates (more than TOKENS_MAX of 5)
      for (let i = 0; i < 6; i++) {
        await batcher.queueUpdate(`msg-${i}`, 'channel-1', embeds, components);
      }

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(250);

      // Should have sent 5 (all tokens)
      expect(editFn).toHaveBeenCalledTimes(5);

      // Advance 1 second for token refill
      await vi.advanceTimersByTimeAsync(1000);

      // Should have sent the 6th
      expect(editFn).toHaveBeenCalledTimes(6);
    });

    it('should refill tokens over time', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      // Consume all tokens
      for (let i = 0; i < 5; i++) {
        await batcher.queueUpdate(`msg-${i}`, 'channel-1', embeds, components);
      }
      await vi.advanceTimersByTimeAsync(250);

      expect(batcher.getTokens()).toBe(0);

      // Wait for refill (1 token per second)
      await vi.advanceTimersByTimeAsync(3000);

      // Queue another update to trigger refill check
      await batcher.queueUpdate('msg-new', 'channel-1', embeds, components);
      await vi.advanceTimersByTimeAsync(250);

      // Should have refilled tokens and sent
      expect(editFn).toHaveBeenCalledTimes(6);
    });
  });

  describe('error handling', () => {
    it('should continue processing after edit failure', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      // First call fails
      editFn.mockRejectedValueOnce(new Error('Discord API error'));

      await batcher.queueUpdate('msg-1', 'channel-1', embeds, components);
      await batcher.queueUpdate('msg-2', 'channel-1', embeds, components);

      await vi.advanceTimersByTimeAsync(250);

      // Both should have been attempted
      expect(editFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('stop()', () => {
    it('should clear pending updates', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      await batcher.queueUpdate('msg-1', 'channel-1', embeds, components);

      batcher.stop();

      expect(batcher.getQueueSize()).toBe(0);
    });

    it('should cancel pending flush timer', async () => {
      const embeds = createMockEmbeds();
      const components = createMockComponents();

      await batcher.queueUpdate('msg-1', 'channel-1', embeds, components);
      batcher.stop();

      await vi.advanceTimersByTimeAsync(1000);

      expect(editFn).not.toHaveBeenCalled();
    });
  });
});
