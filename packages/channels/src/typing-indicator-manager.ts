import { createLogger } from '@kynetic-bot/core';

const DEFAULT_REFRESH_INTERVAL = 8000; // 8 seconds
const MAX_TYPING_DURATION = 60000; // 60 seconds (safety timeout)

interface TypingLoop {
  channelId: string;
  intervalId: NodeJS.Timeout;
  startedAt: number;
  messageId: string;
}

export class TypingIndicatorManager {
  private readonly logger = createLogger('typing-indicator');
  private activeLoops = new Map<string, TypingLoop>();
  private readonly refreshInterval: number;
  private readonly maxDuration: number;

  constructor(options?: { refreshInterval?: number; maxDuration?: number }) {
    this.refreshInterval = options?.refreshInterval ?? DEFAULT_REFRESH_INTERVAL;
    this.maxDuration = options?.maxDuration ?? MAX_TYPING_DURATION;
  }

  async startTyping(
    channelId: string,
    messageId: string,
    sendFn: () => Promise<void>
  ): Promise<void> {
    // Don't start new loop if already active for this channel
    if (this.activeLoops.has(channelId)) {
      this.logger.debug('Typing already active', { channelId });
      return;
    }

    // Send initial typing indicator immediately
    try {
      await sendFn();
    } catch (error) {
      this.logger.warn('Initial typing send failed', { channelId, error });
      // Continue anyway - non-critical
    }

    const startedAt = Date.now();

    // Set up periodic refresh
    // Set up periodic refresh
    const intervalId = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      // Safety timeout: stop after max duration
      if (elapsed >= this.maxDuration) {
        this.logger.warn('Typing loop exceeded max duration', {
          channelId,
          elapsed,
          maxDuration: this.maxDuration,
        });
        this.stopTyping(channelId);
        return;
      }

      // Execute sendFn and handle errors (don't await - fire and forget)
      sendFn().catch((error: unknown) => {
        this.logger.warn('Typing refresh failed', { channelId, error });
        // Don't stop loop on error - transient failures common
      });
    }, this.refreshInterval);

    this.activeLoops.set(channelId, {
      channelId,
      intervalId,
      startedAt,
      messageId,
    });

    this.logger.debug('Typing loop started', { channelId, messageId });
  }

  stopTyping(channelId: string): void {
    const loop = this.activeLoops.get(channelId);
    if (!loop) {
      return;
    }

    clearInterval(loop.intervalId);
    this.activeLoops.delete(channelId);

    const duration = Date.now() - loop.startedAt;
    this.logger.debug('Typing loop stopped', { channelId, duration });
  }

  stopAll(): void {
    for (const channelId of this.activeLoops.keys()) {
      this.stopTyping(channelId);
    }
  }

  // For testing/observability
  isActive(channelId: string): boolean {
    return this.activeLoops.has(channelId);
  }

  getActiveCount(): number {
    return this.activeLoops.size;
  }
}
