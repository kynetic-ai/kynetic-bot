/**
 * Tests for restart protocol client
 *
 * @see @restart-protocol
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RestartProtocol,
  NoIpcChannelError,
  RestartPendingError,
  type RestartOptions,
} from '../src/restart.js';

describe('RestartProtocol', () => {
  let protocol: RestartProtocol;
  let originalSend: typeof process.send;

  beforeEach(() => {
    protocol = new RestartProtocol();
    originalSend = process.send;
  });

  afterEach(() => {
    process.send = originalSend;
  });

  describe('requestRestart()', () => {
    // AC: @restart-protocol ac-1
    it('sends planned_restart message via IPC', async () => {
      const sentMessages: unknown[] = [];
      process.send = vi.fn((msg: unknown) => {
        sentMessages.push(msg);
        // Simulate supervisor acknowledgment
        setTimeout(() => {
          process.emit('message', { type: 'restart_ack' });
        }, 10);
        return true;
      });

      const options: RestartOptions = {
        checkpointPath: '/tmp/test-checkpoint.json',
        timeoutMs: 1000,
      };

      await protocol.requestRestart(options);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toEqual({
        type: 'planned_restart',
        checkpoint: '/tmp/test-checkpoint.json',
      });
    });

    // AC: @restart-protocol ac-6
    it('throws NoIpcChannelError when not supervised', async () => {
      process.send = undefined;

      const options: RestartOptions = {
        checkpointPath: '/tmp/test.json',
      };

      await expect(protocol.requestRestart(options)).rejects.toThrow(NoIpcChannelError);
      await expect(protocol.requestRestart(options)).rejects.toThrow(
        'IPC channel not available'
      );
    });

    // AC: @restart-protocol ac-7
    it('retries once after timeout', async () => {
      let sendCount = 0;
      process.send = vi.fn(() => {
        sendCount++;
        // Don't send acknowledgment - force timeout
        // On second attempt, send ack
        if (sendCount === 2) {
          setTimeout(() => {
            process.emit('message', { type: 'restart_ack' });
          }, 10);
        }
        return true;
      });

      const options: RestartOptions = {
        checkpointPath: '/tmp/test.json',
        timeoutMs: 100,
        maxRetries: 1,
      };

      await protocol.requestRestart(options);

      // Should have sent twice (initial + 1 retry)
      expect(sendCount).toBe(2);
    }, 10000);

    // AC: @restart-protocol ac-7
    it('logs warning and throws after max retries exceeded', async () => {
      process.send = vi.fn(() => {
        // Never send acknowledgment
        return true;
      });

      const options: RestartOptions = {
        checkpointPath: '/tmp/test.json',
        timeoutMs: 50,
        maxRetries: 1,
      };

      await expect(protocol.requestRestart(options)).rejects.toThrow(
        'Restart acknowledgment timeout'
      );

      // Should have sent twice (initial + 1 retry)
      expect(process.send).toHaveBeenCalledTimes(2);
    }, 10000);

    // AC: @restart-protocol ac-8
    it('rejects duplicate request while restart pending', async () => {
      process.send = vi.fn(() => {
        // Never send acknowledgment to keep request pending
        return true;
      });

      const options: RestartOptions = {
        checkpointPath: '/tmp/test.json',
        timeoutMs: 500,
        maxRetries: 0,
      };

      // Start first request (won't complete)
      const firstRequest = protocol.requestRestart(options);

      // Try second request immediately
      await expect(protocol.requestRestart(options)).rejects.toThrow(RestartPendingError);
      await expect(protocol.requestRestart(options)).rejects.toThrow(
        'Restart request already pending'
      );

      // Clean up
      await expect(firstRequest).rejects.toThrow('Restart acknowledgment timeout');
    }, 10000);

    // AC: @restart-protocol ac-1
    it('completes successfully when ack received', async () => {
      process.send = vi.fn(() => {
        setTimeout(() => {
          process.emit('message', { type: 'restart_ack' });
        }, 10);
        return true;
      });

      const options: RestartOptions = {
        checkpointPath: '/tmp/test.json',
        timeoutMs: 1000,
      };

      await expect(protocol.requestRestart(options)).resolves.toBeUndefined();
    });
  });

  describe('isSupervised()', () => {
    // AC: @restart-protocol ac-6
    it('returns true when IPC channel available', () => {
      process.send = vi.fn(() => true);
      expect(protocol.isSupervised()).toBe(true);
    });

    // AC: @restart-protocol ac-6
    it('returns false when no IPC channel', () => {
      process.send = undefined;
      expect(protocol.isSupervised()).toBe(false);
    });
  });

  describe('isPending()', () => {
    // AC: @restart-protocol ac-8
    it('returns false when no restart pending', () => {
      expect(protocol.isPending()).toBe(false);
    });

    // AC: @restart-protocol ac-8
    it('returns true during restart request', async () => {
      process.send = vi.fn(() => {
        // Delay acknowledgment
        setTimeout(() => {
          process.emit('message', { type: 'restart_ack' });
        }, 100);
        return true;
      });

      const options: RestartOptions = {
        checkpointPath: '/tmp/test.json',
        timeoutMs: 1000,
      };

      const restartPromise = protocol.requestRestart(options);

      // Should be pending immediately after request
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(protocol.isPending()).toBe(true);

      // Wait for completion
      await restartPromise;

      // Should no longer be pending
      expect(protocol.isPending()).toBe(false);
    });
  });

  describe('error handling', () => {
    it('ignores non-restart_ack messages while waiting', async () => {
      process.send = vi.fn(() => {
        // Send some other messages first
        setTimeout(() => {
          process.emit('message', { type: 'error', message: 'test' });
          process.emit('message', { type: 'unknown' });
          // Then send the ack
          setTimeout(() => {
            process.emit('message', { type: 'restart_ack' });
          }, 20);
        }, 10);
        return true;
      });

      const options: RestartOptions = {
        checkpointPath: '/tmp/test.json',
        timeoutMs: 1000,
      };

      await expect(protocol.requestRestart(options)).resolves.toBeUndefined();
    });

    it('cleans up listeners after completion', async () => {
      process.send = vi.fn(() => {
        setTimeout(() => {
          process.emit('message', { type: 'restart_ack' });
        }, 10);
        return true;
      });

      const options: RestartOptions = {
        checkpointPath: '/tmp/test.json',
      };

      const listenersBefore = process.listenerCount('message');
      await protocol.requestRestart(options);
      const listenersAfter = process.listenerCount('message');

      // Should not leak listeners
      expect(listenersAfter).toBe(listenersBefore);
    });

    it('cleans up listeners after timeout', async () => {
      process.send = vi.fn(() => true);

      const options: RestartOptions = {
        checkpointPath: '/tmp/test.json',
        timeoutMs: 50,
        maxRetries: 0,
      };

      const listenersBefore = process.listenerCount('message');

      await expect(protocol.requestRestart(options)).rejects.toThrow();

      const listenersAfter = process.listenerCount('message');

      // Should not leak listeners even on timeout
      expect(listenersAfter).toBe(listenersBefore);
    }, 10000);
  });
});
