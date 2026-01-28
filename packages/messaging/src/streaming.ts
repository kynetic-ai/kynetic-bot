/**
 * Stream Coalescer
 *
 * Handles streaming response delivery with configurable chunking and rate limiting.
 */

import type { KyneticError } from '@kynetic-bot/core';
import { createLogger, type Logger } from '@kynetic-bot/core';

/**
 * Options for stream coalescing
 */
export interface StreamOptions {
  /** Minimum characters before flushing a chunk (default: 1500) */
  minChars?: number;
  /** Idle time in ms before flushing (default: 1000) */
  idleMs?: number;
  /** Callback for each chunk delivered */
  onChunk: (chunk: string) => Promise<void>;
  /** Callback when stream completes */
  onComplete: (fullText: string) => Promise<void>;
  /** Callback for errors during streaming */
  onError: (error: KyneticError) => Promise<void>;
  /** Logger instance (optional) */
  logger?: Logger;
}

/**
 * StreamCoalescer manages streaming response delivery
 *
 * Buffers incoming text and flushes chunks based on size or idle time.
 * Supports both streaming and buffered (non-streaming) delivery modes.
 */
export class StreamCoalescer {
  private buffer = '';
  private lastFlush = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private completed = false;
  private aborted = false;
  private fullText = '';
  private readonly minChars: number;
  private readonly idleMs: number;
  private readonly logger: Logger;

  constructor(private readonly options: StreamOptions) {
    this.minChars = options.minChars ?? 1500;
    this.idleMs = options.idleMs ?? 1000;
    this.logger = options.logger ?? createLogger('StreamCoalescer');
  }

  /**
   * Push text into the stream
   *
   * Text is buffered and flushed when conditions are met.
   *
   * @param text - Text to add to the stream
   */
  async push(text: string): Promise<void> {
    if (this.completed || this.aborted) {
      this.logger.warn('Attempted to push to completed or aborted stream');
      return;
    }

    this.buffer += text;
    this.fullText += text;

    // Clear existing timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // AC-1: Flush when buffer size threshold is met
    if (this.shouldFlush()) {
      await this.flush();
    } else {
      // AC-1: Set timer to flush after idle period
      this.scheduleFlush();
    }
  }

  /**
   * Flush the current buffer as a chunk
   */
  async flush(): Promise<void> {
    if (this.aborted) {
      return;
    }

    if (this.buffer.length === 0) {
      return;
    }

    const chunk = this.buffer;
    this.buffer = '';
    this.lastFlush = Date.now();

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    try {
      await this.options.onChunk(chunk);
    } catch (error) {
      this.logger.error('Error flushing chunk', { error });
      throw error;
    }
  }

  /**
   * Complete the stream and deliver any remaining buffered content
   *
   * AC-3: For non-streaming platforms, buffers complete response.
   */
  async complete(): Promise<void> {
    if (this.completed || this.aborted) {
      return;
    }

    this.completed = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    try {
      // Flush any remaining buffer
      if (this.buffer.length > 0) {
        await this.flush();
      }

      // Call completion handler with full text
      await this.options.onComplete(this.fullText);
    } catch (error) {
      this.logger.error('Error completing stream', { error });
      throw error;
    }
  }

  /**
   * Abort the stream and clean up resources
   *
   * AC-2: Handles client disconnection, cleans up and logs.
   */
  abort(): void {
    if (this.aborted || this.completed) {
      return;
    }

    this.aborted = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // AC-2: Log disconnection
    this.logger.info('Stream aborted (client disconnected)', {
      bufferedChars: this.buffer.length,
      totalChars: this.fullText.length,
    });

    // Clear buffers to free memory
    this.buffer = '';
  }

  /**
   * Check if buffer should be flushed based on size threshold
   */
  private shouldFlush(): boolean {
    return this.buffer.length >= this.minChars;
  }

  /**
   * Schedule a flush after idle timeout
   */
  private scheduleFlush(): void {
    this.timer = setTimeout(() => {
      this.flush().catch((error) => {
        this.logger.error('Error in scheduled flush', { error });
        this.options.onError(error as KyneticError).catch((err) => {
          this.logger.error('Error in onError handler', { error: err });
        });
      });
    }, this.idleMs);
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Get total text received so far
   */
  getTotalSize(): number {
    return this.fullText.length;
  }

  /**
   * Check if stream is completed
   */
  isCompleted(): boolean {
    return this.completed;
  }

  /**
   * Check if stream is aborted
   */
  isAborted(): boolean {
    return this.aborted;
  }
}

/**
 * Non-streaming buffered coalescer
 *
 * Buffers entire response and sends as single message on completion.
 * AC-3: Fallback for platforms that don't support streaming.
 */
export class BufferedCoalescer {
  private buffer = '';
  private completed = false;
  private readonly logger: Logger;

  constructor(
    private readonly onComplete: (fullText: string) => Promise<void>,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger('BufferedCoalescer');
  }

  /**
   * Push text into the buffer
   */
  async push(text: string): Promise<void> {
    if (this.completed) {
      this.logger.warn('Attempted to push to completed buffer');
      return;
    }

    this.buffer += text;
  }

  /**
   * Complete buffering and send full message
   *
   * AC-3: Sends complete response as single message.
   */
  async complete(): Promise<void> {
    if (this.completed) {
      return;
    }

    this.completed = true;

    try {
      await this.onComplete(this.buffer);
    } catch (error) {
      this.logger.error('Error sending buffered message', { error });
      throw error;
    }
  }

  /**
   * Get current buffer size
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Check if buffer is completed
   */
  isCompleted(): boolean {
    return this.completed;
  }
}
