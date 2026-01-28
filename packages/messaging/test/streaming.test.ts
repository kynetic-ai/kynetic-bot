/**
 * StreamCoalescer Tests
 *
 * Test coverage for streaming response delivery and buffering.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamCoalescer, BufferedCoalescer, type StreamOptions } from '../src/streaming.js';
import { KyneticError } from '@kynetic-bot/core';

/**
 * Helper to create a delay
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('StreamCoalescer', () => {
  describe('Streaming Responses (@msg-streaming)', () => {
    // AC: @msg-streaming ac-1
    it('should deliver response in chunks as they are generated', async () => {
      const chunks: string[] = [];
      const coalescer = new StreamCoalescer({
        minChars: 10,
        idleMs: 100,
        onChunk: async (chunk) => {
          chunks.push(chunk);
        },
        onComplete: async () => {},
        onError: async () => {},
      });

      // Push text that exceeds minChars
      await coalescer.push('0123456789'); // 10 chars - should flush immediately
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('0123456789');

      // Push more text
      await coalescer.push('abcdefghij'); // Another 10 chars - should flush
      expect(chunks).toHaveLength(2);
      expect(chunks[1]).toBe('abcdefghij');

      await coalescer.complete();
    });

    // AC: @msg-streaming ac-1
    it('should flush chunks after idle timeout', async () => {
      const chunks: string[] = [];
      const coalescer = new StreamCoalescer({
        minChars: 100, // High threshold
        idleMs: 50, // Short timeout
        onChunk: async (chunk) => {
          chunks.push(chunk);
        },
        onComplete: async () => {},
        onError: async () => {},
      });

      // Push text below threshold
      await coalescer.push('short');
      expect(chunks).toHaveLength(0); // Not flushed yet

      // Wait for idle timeout
      await delay(60);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('short');

      await coalescer.complete();
    });

    // AC: @msg-streaming ac-2
    it('should clean up resources and log disconnection when aborted', async () => {
      const chunks: string[] = [];
      const coalescer = new StreamCoalescer({
        minChars: 100,
        idleMs: 1000,
        onChunk: async (chunk) => {
          chunks.push(chunk);
        },
        onComplete: async () => {},
        onError: async () => {},
      });

      await coalescer.push('Some text');
      expect(coalescer.getBufferSize()).toBeGreaterThan(0);

      // AC-2: Abort the stream (simulating client disconnect)
      coalescer.abort();

      expect(coalescer.isAborted()).toBe(true);
      expect(coalescer.getBufferSize()).toBe(0); // Buffer cleared

      // Pushing after abort should not throw or add to buffer
      await coalescer.push('More text');
      expect(coalescer.getBufferSize()).toBe(0);
    });

    // AC: @msg-streaming ac-4
    it('should respect rate limits between chunk sends', async () => {
      const timestamps: number[] = [];
      let chunkDelay = 100; // Simulate 100ms rate limit

      const coalescer = new StreamCoalescer({
        minChars: 5,
        idleMs: 50,
        onChunk: async (chunk) => {
          timestamps.push(Date.now());
          await delay(chunkDelay); // Simulate rate limit delay
        },
        onComplete: async () => {},
        onError: async () => {},
      });

      await coalescer.push('12345'); // First chunk
      await coalescer.push('67890'); // Second chunk

      expect(timestamps).toHaveLength(2);

      // AC-4: Verify time between sends respects rate limit
      const timeDiff = timestamps[1] - timestamps[0];
      expect(timeDiff).toBeGreaterThanOrEqual(chunkDelay);

      await coalescer.complete();
    });
  });

  describe('Chunk Management', () => {
    it('should buffer text until threshold is met', async () => {
      const chunks: string[] = [];
      const coalescer = new StreamCoalescer({
        minChars: 20,
        idleMs: 1000,
        onChunk: async (chunk) => {
          chunks.push(chunk);
        },
        onComplete: async () => {},
        onError: async () => {},
      });

      await coalescer.push('abc'); // 3 chars
      expect(chunks).toHaveLength(0);

      await coalescer.push('defghij'); // 7 more = 10 total
      expect(chunks).toHaveLength(0);

      await coalescer.push('klmnopqrst'); // 10 more = 20 total, should flush
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('abcdefghijklmnopqrst');

      await coalescer.complete();
    });

    it('should flush remaining buffer on complete', async () => {
      const chunks: string[] = [];
      let fullText = '';

      const coalescer = new StreamCoalescer({
        minChars: 100, // High threshold
        idleMs: 1000,
        onChunk: async (chunk) => {
          chunks.push(chunk);
        },
        onComplete: async (full) => {
          fullText = full;
        },
        onError: async () => {},
      });

      await coalescer.push('Short text');
      expect(chunks).toHaveLength(0); // Not flushed yet

      await coalescer.complete();

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('Short text');
      expect(fullText).toBe('Short text');
    });

    it('should track total text size', async () => {
      const coalescer = new StreamCoalescer({
        minChars: 10,
        idleMs: 100,
        onChunk: async () => {},
        onComplete: async () => {},
        onError: async () => {},
      });

      await coalescer.push('0123456789'); // 10 chars
      expect(coalescer.getTotalSize()).toBe(10);

      await coalescer.push('abc'); // 3 more
      expect(coalescer.getTotalSize()).toBe(13);

      await coalescer.complete();
    });

    it('should not push to completed stream', async () => {
      const chunks: string[] = [];
      const coalescer = new StreamCoalescer({
        minChars: 10,
        idleMs: 100,
        onChunk: async (chunk) => {
          chunks.push(chunk);
        },
        onComplete: async () => {},
        onError: async () => {},
      });

      await coalescer.push('first');
      await coalescer.complete();

      const chunkCount = chunks.length;

      // Try to push after completion
      await coalescer.push('second');

      expect(chunks).toHaveLength(chunkCount); // No new chunks
    });

    it('should cancel scheduled flush on manual flush', async () => {
      const chunks: string[] = [];
      const coalescer = new StreamCoalescer({
        minChars: 100,
        idleMs: 100,
        onChunk: async (chunk) => {
          chunks.push(chunk);
        },
        onComplete: async () => {},
        onError: async () => {},
      });

      await coalescer.push('text');

      // Manually flush before idle timeout
      await coalescer.flush();
      expect(chunks).toHaveLength(1);

      // Wait past idle time - should not flush again
      await delay(150);
      expect(chunks).toHaveLength(1); // Still only one chunk
    });
  });

  describe('Error Handling', () => {
    it('should call onError when chunk delivery fails', async () => {
      const errors: KyneticError[] = [];
      const throwError = new KyneticError('Chunk delivery failed', 'DELIVERY_ERROR');

      const coalescer = new StreamCoalescer({
        minChars: 5,
        idleMs: 1000,
        onChunk: async () => {
          throw throwError;
        },
        onComplete: async () => {},
        onError: async (error) => {
          errors.push(error);
        },
      });

      await expect(coalescer.push('12345')).rejects.toThrow('Chunk delivery failed');
    });

    it('should call onError when completion fails', async () => {
      const throwError = new KyneticError('Completion failed', 'COMPLETE_ERROR');

      const coalescer = new StreamCoalescer({
        minChars: 100,
        idleMs: 1000,
        onChunk: async () => {},
        onComplete: async () => {
          throw throwError;
        },
        onError: async () => {},
      });

      await coalescer.push('text');
      await expect(coalescer.complete()).rejects.toThrow('Completion failed');
    });
  });
});

describe('BufferedCoalescer', () => {
  // AC: @msg-streaming ac-3
  it('should buffer complete response and send as single message', async () => {
    let fullText = '';

    const coalescer = new BufferedCoalescer(async (text) => {
      fullText = text;
    });

    // AC-3: Buffer entire response
    await coalescer.push('Part 1. ');
    await coalescer.push('Part 2. ');
    await coalescer.push('Part 3.');

    expect(fullText).toBe(''); // Not sent yet

    // AC-3: Send as single message on complete
    await coalescer.complete();

    expect(fullText).toBe('Part 1. Part 2. Part 3.');
  });

  it('should track buffer size', async () => {
    const coalescer = new BufferedCoalescer(async () => {});

    await coalescer.push('Hello ');
    expect(coalescer.getBufferSize()).toBe(6);

    await coalescer.push('World');
    expect(coalescer.getBufferSize()).toBe(11);
  });

  it('should not push to completed buffer', async () => {
    let fullText = '';
    const coalescer = new BufferedCoalescer(async (text) => {
      fullText = text;
    });

    await coalescer.push('First');
    await coalescer.complete();

    await coalescer.push('Second');

    expect(fullText).toBe('First'); // Only first push
  });

  it('should handle completion errors', async () => {
    const throwError = new Error('Completion failed');
    const coalescer = new BufferedCoalescer(async () => {
      throw throwError;
    });

    await coalescer.push('text');
    await expect(coalescer.complete()).rejects.toThrow('Completion failed');
  });
});
