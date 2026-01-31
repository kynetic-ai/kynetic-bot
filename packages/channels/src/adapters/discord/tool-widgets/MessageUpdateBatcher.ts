/**
 * MessageUpdateBatcher - Batches Discord message edits to respect rate limits
 *
 * Discord rate limit: 5 edits per 5 seconds per channel
 * Strategy: Token bucket with 1 edit/second refill rate (safety margin)
 * Behavior: Batches rapid updates with 200ms debounce window
 *
 * @see @discord-tool-widgets
 */

import { createLogger } from '@kynetic-bot/core';
import type { EmbedBuilder, ActionRowBuilder, ButtonBuilder, Message } from 'discord.js';

const TOKENS_MAX = 5;
const REFILL_RATE_MS = 1000; // 1 token per second (conservative vs Discord's 5/5s)
const DEBOUNCE_MS = 200; // Batch updates within 200ms window
const MAX_QUEUE_SIZE = 50;

/**
 * Pending update for a message
 */
interface PendingUpdate {
  channelId: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  timestamp: number;
}

/**
 * Message edit function type
 */
export type MessageEditFn = (
  channelId: string,
  messageId: string,
  embeds: EmbedBuilder[],
  components: ActionRowBuilder<ButtonBuilder>[]
) => Promise<Message | null>;

/**
 * MessageUpdateBatcher - Rate-limited message edit batcher
 *
 * AC: @discord-tool-widgets ac-5
 */
export class MessageUpdateBatcher {
  private readonly logger = createLogger('message-update-batcher');
  private readonly queue = new Map<string, PendingUpdate>();
  private readonly editMessage: MessageEditFn;

  private tokens: number = TOKENS_MAX;
  private lastRefill: number = Date.now();
  private flushTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(editMessage: MessageEditFn) {
    this.editMessage = editMessage;
  }

  /**
   * Queue a message update
   *
   * If an update for the same message is already queued, it will be replaced
   * (batching multiple rapid updates into one).
   *
   * @param messageId - Discord message ID
   * @param channelId - Discord channel ID
   * @param embeds - Updated embeds
   * @param components - Updated components
   */
  async queueUpdate(
    messageId: string,
    channelId: string,
    embeds: EmbedBuilder[],
    components: ActionRowBuilder<ButtonBuilder>[]
  ): Promise<void> {
    // Check queue size limit
    if (this.queue.size >= MAX_QUEUE_SIZE && !this.queue.has(messageId)) {
      this.logger.warn('Queue size limit reached, dropping update', {
        messageId,
        queueSize: this.queue.size,
      });
      return;
    }

    // Add or replace in queue (batching)
    this.queue.set(messageId, {
      channelId,
      embeds,
      components,
      timestamp: Date.now(),
    });

    this.logger.debug('Queued message update', {
      messageId,
      queueSize: this.queue.size,
    });

    // Schedule flush with debounce
    this.scheduleFlush();
  }

  /**
   * Schedule a flush with debounce
   */
  private scheduleFlush(): void {
    // Clear existing timer (debounce)
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }

    // Schedule new flush
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, DEBOUNCE_MS);
  }

  /**
   * Flush pending updates
   */
  private async flush(): Promise<void> {
    if (this.isProcessing) {
      // Already processing, reschedule
      this.scheduleFlush();
      return;
    }

    this.isProcessing = true;

    try {
      while (this.queue.size > 0) {
        // Refill tokens
        this.refillTokens();

        // Wait for token availability
        if (this.tokens < 1) {
          const waitTime = REFILL_RATE_MS - (Date.now() - this.lastRefill);
          if (waitTime > 0) {
            this.logger.debug('Rate limited, waiting for token', { waitTime });
            await this.sleep(waitTime);
            this.refillTokens();
          }
        }

        // Process one update
        if (this.tokens >= 1 && this.queue.size > 0) {
          const [messageId, update] = this.queue.entries().next().value as [string, PendingUpdate];
          this.queue.delete(messageId);
          this.tokens--;

          try {
            await this.editMessage(update.channelId, messageId, update.embeds, update.components);

            this.logger.debug('Sent message update', {
              messageId,
              tokensRemaining: this.tokens,
            });
          } catch (error) {
            this.logger.error('Failed to edit message', {
              error: error instanceof Error ? error.message : String(error),
              messageId,
            });
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Refill tokens based on time elapsed
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.floor(elapsed / REFILL_RATE_MS);

    if (tokensToAdd > 0) {
      this.tokens = Math.min(TOKENS_MAX, this.tokens + tokensToAdd);
      this.lastRefill = now;
    }
  }

  /**
   * Sleep for a given duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Stop the batcher and clear pending updates
   */
  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.queue.clear();
    this.logger.info('Message update batcher stopped');
  }

  /**
   * Get current queue size (for debugging/testing)
   */
  getQueueSize(): number {
    return this.queue.size;
  }

  /**
   * Get available tokens (for debugging/testing)
   */
  getTokens(): number {
    return this.tokens;
  }
}
