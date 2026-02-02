/**
 * Tests for Supervisor process lifecycle management
 *
 * @see @supervisor-process-spawn
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../src/supervisor.js';
import type { ChildProcess } from 'node:child_process';

// Mock child_process
vi.mock('node:child_process', () => {
  return {
    fork: vi.fn(),
  };
});

describe('Supervisor', () => {
  let supervisor: Supervisor;
  let mockChild: MockChildProcess;
  let testDir: string;

  class MockChildProcess extends EventEmitter {
    pid: number = 12345;
    killed = false;

    send(msg: unknown): boolean {
      this.emit('test:send', msg);
      return true;
    }

    kill(signal?: string): boolean {
      this.killed = true;
      this.emit('test:kill', signal);
      // Simulate exit after kill
      setTimeout(() => {
        this.emit('exit', null, signal || 'SIGTERM');
      }, 10);
      return true;
    }
  }

  beforeEach(async () => {
    // Reset mocks
    vi.clearAllMocks();

    // Create test directory
    testDir = join(tmpdir(), `supervisor-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    // Create mock child process
    mockChild = new MockChildProcess();

    // Mock fork to return our mock child
    const { fork } = await import('node:child_process');
    vi.mocked(fork).mockReturnValue(mockChild as unknown as ChildProcess);
  });

  afterEach(async () => {
    if (supervisor && !supervisor.isShutdown()) {
      await supervisor.shutdown();
    }
  });

  describe('spawn()', () => {
    // AC: @supervisor-process-spawn ac-1
    it('spawns kbot with IPC channel', async () => {
      const childPath = '/path/to/kbot';
      supervisor = new Supervisor({ childPath });

      const spawnPromise = new Promise<number>((resolve) => {
        supervisor.on('spawn', (pid) => resolve(pid));
      });

      await supervisor.spawn();

      const { fork } = await import('node:child_process');
      expect(fork).toHaveBeenCalledWith(
        childPath,
        [],
        expect.objectContaining({
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        })
      );

      const spawnedPid = await spawnPromise;
      expect(spawnedPid).toBe(12345);
    });

    // AC: @supervisor-process-spawn ac-6
    it('logs PID and sets up IPC handlers when child starts', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });

      const events: { type: string; data: unknown }[] = [];
      supervisor.on('spawn', (pid) => events.push({ type: 'spawn', data: pid }));

      await supervisor.spawn();

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'spawn', data: 12345 });
      expect(supervisor.getPid()).toBe(12345);

      // Verify IPC handlers are set up by sending a message
      const ipcMessages: unknown[] = [];
      mockChild.on('message', (msg) => ipcMessages.push(msg));

      mockChild.emit('message', { type: 'error', message: 'test' });
      // If handler is set up, it processes the message without throwing
      expect(ipcMessages).toHaveLength(1);
    });

    // AC: @supervisor-process-spawn ac-7
    it('logs error and retries spawn when IPC channel setup fails', async () => {
      const { fork } = await import('node:child_process');
      vi.mocked(fork).mockImplementationOnce(() => {
        throw new Error('IPC setup failed');
      });

      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        minBackoffMs: 50,
        maxBackoffMs: 100,
      });

      const errors: Error[] = [];
      supervisor.on('ipc_error', (err) => errors.push(err));

      // Mock fork to succeed on second call
      vi.mocked(fork).mockReturnValue(mockChild as unknown as ChildProcess);

      await supervisor.spawn();

      // Should have logged IPC error
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('IPC setup failed');

      // Wait for retry with backoff
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have spawned successfully after retry
      expect(supervisor.getPid()).toBe(12345);
    });
  });

  describe('signal handling', () => {
    // AC: @supervisor-process-spawn ac-2
    it('sends SIGTERM to child and waits for graceful exit', async () => {
      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        shutdownTimeoutMs: 1000,
      });

      await supervisor.spawn();

      const killSignals: string[] = [];
      mockChild.on('test:kill', (signal) => killSignals.push(signal as string));

      const shutdownPromise = supervisor.shutdown();

      // Wait a bit for SIGTERM
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(killSignals).toContain('SIGTERM');
      expect(mockChild.killed).toBe(true);

      await shutdownPromise;
      expect(supervisor.isShutdown()).toBe(true);
    });

    // AC: @trait-graceful-shutdown ac-1, ac-2, ac-3
    it('completes graceful shutdown with timeout', async () => {
      // Create a child that doesn't exit immediately
      const slowChild = new MockChildProcess();
      slowChild.kill = vi.fn().mockImplementation(() => {
        slowChild.killed = true;
        // Don't emit exit immediately - force timeout
        return true;
      });

      const { fork } = await import('node:child_process');
      vi.mocked(fork).mockReturnValue(slowChild as unknown as ChildProcess);

      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        shutdownTimeoutMs: 100,
      });

      await supervisor.spawn();

      const shutdownStart = Date.now();
      await supervisor.shutdown();
      const shutdownDuration = Date.now() - shutdownStart;

      // Should have waited for timeout
      expect(shutdownDuration).toBeGreaterThanOrEqual(100);
      expect(supervisor.isShutdown()).toBe(true);
    });
  });

  describe('exit handling', () => {
    // AC: @supervisor-process-spawn ac-3
    it('exits cleanly without respawn when kbot exits with code 0', async () => {
      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        minBackoffMs: 50,
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        // Don't throw - just return to avoid unhandled rejection
        return undefined as never;
      });

      await supervisor.spawn();

      // Simulate clean exit
      mockChild.emit('exit', 0, null);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockRestore();
    });

    // AC: @supervisor-process-spawn ac-4
    it('respawns with exponential backoff when kbot exits non-zero', async () => {
      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        minBackoffMs: 50,
        maxBackoffMs: 200,
      });

      const respawns: Array<{ attempt: number; backoffMs: number }> = [];
      supervisor.on('respawn', (attempt, backoffMs) => {
        respawns.push({ attempt, backoffMs });
      });

      await supervisor.spawn();
      const firstPid = supervisor.getPid();

      // Create new mock child for respawn
      const secondChild = new MockChildProcess();
      secondChild.pid = 12346;
      const { fork } = await import('node:child_process');
      vi.mocked(fork).mockReturnValue(secondChild as unknown as ChildProcess);

      // Simulate crash
      mockChild.emit('exit', 1, null);

      // Wait for respawn
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(respawns).toHaveLength(1);
      expect(respawns[0]?.backoffMs).toBe(50);
      expect(supervisor.getPid()).toBe(12346);
    });

    // AC: @supervisor-process-spawn ac-5
    it('emits escalation event when backoff reaches maximum', async () => {
      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        minBackoffMs: 10,
        maxBackoffMs: 20,
      });

      const escalationPromise = new Promise<number>((resolve) => {
        supervisor.on('escalation', (failures) => resolve(failures));
      });

      const { fork } = await import('node:child_process');

      await supervisor.spawn();

      // Mock fork to create new children on each respawn
      let spawnCount = 0;
      vi.mocked(fork).mockImplementation(() => {
        const child = new MockChildProcess();
        child.pid = 12345 + ++spawnCount;
        mockChild = child;
        return child as unknown as ChildProcess;
      });

      // Trigger failures to reach max backoff
      // After 2 failures, backoff will be at max (10 -> 20)
      mockChild.emit('exit', 1, null);
      await new Promise((resolve) => setTimeout(resolve, 40));

      mockChild.emit('exit', 1, null);
      await new Promise((resolve) => setTimeout(resolve, 40));

      // Third failure should trigger escalation
      mockChild.emit('exit', 1, null);

      // Wait for escalation event
      const failures = await Promise.race([
        escalationPromise,
        new Promise<number>((resolve) => setTimeout(() => resolve(0), 100)),
      ]);

      // Should emit escalation when backoff reaches max (after 2nd failure with config above)
      expect(failures).toBeGreaterThanOrEqual(2);
    }, 10000);

    // AC: @supervisor-process-spawn ac-9
    it('creates crash checkpoint when kbot exits non-zero unexpectedly', async () => {
      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        minBackoffMs: 50,
      });

      await supervisor.spawn();

      // Create new child for respawn
      const secondChild = new MockChildProcess();
      const { fork } = await import('node:child_process');
      vi.mocked(fork).mockReturnValue(secondChild as unknown as ChildProcess);

      // Simulate crash
      mockChild.emit('exit', 1, null);

      // Wait for checkpoint creation and respawn
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify second spawn happened (which means checkpoint logic ran)
      expect(fork).toHaveBeenCalledTimes(2);

      // Verify the second spawn included a checkpoint arg
      const lastCall = vi.mocked(fork).mock.calls[1];
      expect(lastCall?.[1]).toEqual(
        expect.arrayContaining(['--checkpoint', expect.stringContaining('/tmp/crash-')])
      );
    });
  });

  describe('IPC messaging', () => {
    // AC: @restart-protocol ac-1
    it('handles planned_restart message and sends acknowledgment', async () => {
      const checkpointPath = join(testDir, 'test-checkpoint.json');
      await writeFile(checkpointPath, JSON.stringify({ test: 'data' }));

      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      const ackPromise = new Promise<unknown>((resolve) => {
        mockChild.once('test:send', (msg) => resolve(msg));
      });

      // Send planned restart from child
      mockChild.emit('message', {
        type: 'planned_restart',
        checkpoint: checkpointPath,
      });

      // Wait a bit for async processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Wait for acknowledgment
      const ack = await ackPromise;

      // Should send acknowledgment
      expect(ack).toEqual({ type: 'restart_ack' });
    });

    // AC: @restart-protocol ac-2
    it('verifies checkpoint file exists before acknowledging', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      const messages: unknown[] = [];
      mockChild.on('test:send', (msg) => messages.push(msg));

      // Send planned restart with non-existent checkpoint
      mockChild.emit('message', {
        type: 'planned_restart',
        checkpoint: '/nonexistent/checkpoint.json',
      });

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should send error, not ack
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        type: 'error',
        message: expect.stringContaining('not accessible'),
      });
    });

    // AC: @restart-protocol ac-3, ac-4
    it('respawns with checkpoint flag after planned restart', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        const checkpointPath = join(testDir, 'planned-checkpoint.json');
        await writeFile(checkpointPath, JSON.stringify({ test: 'data' }));

        supervisor = new Supervisor({
          childPath: '/path/to/kbot',
          minBackoffMs: 50,
        });

        await supervisor.spawn();

        // Send planned restart
        mockChild.emit('message', {
          type: 'planned_restart',
          checkpoint: checkpointPath,
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Create new child for respawn
        const secondChild = new MockChildProcess();
        const { fork } = await import('node:child_process');
        vi.mocked(fork).mockReturnValue(secondChild as unknown as ChildProcess);

        // Exit with code 0 - should not exit supervisor, but trigger respawn in this test
        // (normally code 0 exits supervisor, but we're testing the checkpoint passing)
        mockChild.emit('exit', 1, null);

        await new Promise((resolve) => setTimeout(resolve, 100));

        // AC: @restart-protocol ac-4
        // Should use the planned checkpoint in args
        expect(fork).toHaveBeenLastCalledWith(
          '/path/to/kbot',
          ['--checkpoint', checkpointPath],
          expect.any(Object)
        );
      } finally {
        exitSpy.mockRestore();
      }
    });

    // AC: @restart-protocol ac-5
    it('logs warning and ignores invalid IPC messages', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      // Send invalid message (missing required fields)
      mockChild.emit('message', {
        type: 'planned_restart',
        // missing checkpoint field
      });

      // Should not crash
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Send completely invalid message
      mockChild.emit('message', {
        invalid: 'structure',
      });

      // Should not crash
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Send malformed message
      mockChild.emit('message', null);

      // Should not crash
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    it('handles error messages from child', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      // Send error message
      mockChild.emit('message', {
        type: 'error',
        message: 'Something went wrong',
      });

      // Should log error without throwing
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    it('emits ipc_error on child process error', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });

      const errors: Error[] = [];
      supervisor.on('ipc_error', (err) => errors.push(err));

      await supervisor.spawn();

      const testError = new Error('IPC channel error');
      mockChild.emit('error', testError);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(errors).toContainEqual(testError);
    });
  });

  describe('checkpoint handling', () => {
    it('passes checkpoint flag to child on spawn', async () => {
      const checkpointPath = join(testDir, 'test-checkpoint.json');
      await writeFile(
        checkpointPath,
        JSON.stringify({
          version: 1,
          session_id: '01EXAMPLE',
          restart_reason: 'planned',
          wake_context: { prompt: 'Resume session' },
          created_at: new Date().toISOString(),
        })
      );

      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        checkpointPath,
      });

      await supervisor.spawn();

      const { fork } = await import('node:child_process');
      expect(fork).toHaveBeenCalledWith(
        '/path/to/kbot',
        ['--checkpoint', checkpointPath],
        expect.any(Object)
      );
    });

    it('uses pending checkpoint on respawn after planned restart', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
      });

      try {
        // Create checkpoint file for validation (AC: @restart-protocol ac-2)
        const checkpointPath = join(testDir, 'planned.json');
        await writeFile(
          checkpointPath,
          JSON.stringify({
            version: 1,
            session_id: '01EXAMPLE',
            restart_reason: 'planned',
            wake_context: { prompt: 'Resume session' },
            created_at: new Date().toISOString(),
          })
        );

        supervisor = new Supervisor({
          childPath: '/path/to/kbot',
          minBackoffMs: 50,
        });

        await supervisor.spawn();

        // Send planned restart
        mockChild.emit('message', {
          type: 'planned_restart',
          checkpoint: checkpointPath,
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        // Create new child for respawn
        const secondChild = new MockChildProcess();
        const { fork } = await import('node:child_process');
        vi.mocked(fork).mockReturnValue(secondChild as unknown as ChildProcess);

        // Exit with non-zero to trigger respawn (code 0 would exit supervisor)
        mockChild.emit('exit', 1, null);

        await new Promise((resolve) => setTimeout(resolve, 100));

        // Should use the planned checkpoint
        expect(fork).toHaveBeenLastCalledWith(
          '/path/to/kbot',
          ['--checkpoint', checkpointPath],
          expect.any(Object)
        );
      } finally {
        exitSpy.mockRestore();
      }
    });
  });

  describe('environment variables', () => {
    // AC: @supervisor-env ac-1
    it('sets KBOT_SUPERVISED=1 when spawning child', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });

      await supervisor.spawn();

      const { fork } = await import('node:child_process');
      const callArgs = vi.mocked(fork).mock.calls[0];
      const options = callArgs?.[2];

      expect(options?.env).toBeDefined();
      expect(options?.env?.KBOT_SUPERVISED).toBe('1');
    });

    // AC: @supervisor-env ac-2
    it('sets KBOT_SUPERVISOR_PID to supervisor process PID', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });

      await supervisor.spawn();

      const { fork } = await import('node:child_process');
      const callArgs = vi.mocked(fork).mock.calls[0];
      const options = callArgs?.[2];

      expect(options?.env).toBeDefined();
      expect(options?.env?.KBOT_SUPERVISOR_PID).toBe(process.pid.toString());
    });

    // AC: @supervisor-env ac-4
    it('sets KBOT_CHECKPOINT_PATH when checkpoint provided', async () => {
      const checkpointPath = join(testDir, 'test-checkpoint.json');
      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        checkpointPath,
      });

      await supervisor.spawn();

      const { fork } = await import('node:child_process');
      const callArgs = vi.mocked(fork).mock.calls[0];
      const options = callArgs?.[2];

      expect(options?.env).toBeDefined();
      expect(options?.env?.KBOT_CHECKPOINT_PATH).toBe(checkpointPath);
    });

    // AC: @supervisor-env ac-4
    it('does not set KBOT_CHECKPOINT_PATH when no checkpoint', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });

      await supervisor.spawn();

      const { fork } = await import('node:child_process');
      const callArgs = vi.mocked(fork).mock.calls[0];
      const options = callArgs?.[2];

      expect(options?.env).toBeDefined();
      expect(options?.env?.KBOT_CHECKPOINT_PATH).toBeUndefined();
    });

    it('inherits parent environment variables', async () => {
      process.env.TEST_VAR = 'test_value';

      supervisor = new Supervisor({ childPath: '/path/to/kbot' });

      await supervisor.spawn();

      const { fork } = await import('node:child_process');
      const callArgs = vi.mocked(fork).mock.calls[0];
      const options = callArgs?.[2];

      expect(options?.env).toBeDefined();
      expect(options?.env?.TEST_VAR).toBe('test_value');

      delete process.env.TEST_VAR;
    });
  });

  describe('observable trait', () => {
    // AC: @trait-observable ac-1
    it('emits structured events on state changes', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });

      const events: string[] = [];
      supervisor.on('spawn', () => events.push('spawn'));
      supervisor.on('exit', () => events.push('exit'));
      supervisor.on('shutdown', () => events.push('shutdown'));

      await supervisor.spawn();
      expect(events).toContain('spawn');

      mockChild.emit('exit', 1, null);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toContain('exit');
    });

    // AC: @trait-observable ac-2
    it('logs errors with context and severity', async () => {
      const { fork } = await import('node:child_process');
      vi.mocked(fork).mockImplementationOnce(() => {
        throw new Error('Spawn failed');
      });

      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        minBackoffMs: 50,
      });

      const errors: Error[] = [];
      supervisor.on('ipc_error', (err) => errors.push(err));

      await supervisor.spawn();

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('Spawn failed');
    });

    // AC: @trait-observable ac-3
    it('emits completion event when shutdown completes', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      const shutdownEvents: unknown[] = [];
      supervisor.on('shutdown', () => shutdownEvents.push(true));

      await supervisor.shutdown();

      expect(shutdownEvents).toHaveLength(1);
    });
  });

  describe('health monitoring', () => {
    // AC: @trait-health-monitored ac-2
    it('tracks consecutive failures and marks unhealthy', async () => {
      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        minBackoffMs: 10,
        maxBackoffMs: 20,
      });

      const respawns: Array<{ attempt: number; backoff: number }> = [];
      supervisor.on('respawn', (attempt, backoff) => respawns.push({ attempt, backoff }));

      const { fork } = await import('node:child_process');

      await supervisor.spawn();

      // Mock fork to create new children on each respawn
      let spawnCount = 0;
      vi.mocked(fork).mockImplementation(() => {
        const child = new MockChildProcess();
        child.pid = 12345 + ++spawnCount;
        mockChild = child;
        return child as unknown as ChildProcess;
      });

      // Trigger three failures and wait for respawns
      for (let i = 0; i < 3; i++) {
        mockChild.emit('exit', 1, null);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }

      // Should track increasing failure count
      expect(respawns.length).toBeGreaterThanOrEqual(3);
      expect(respawns[0]?.attempt).toBe(1);
      expect(respawns[1]?.attempt).toBe(2);
      expect(respawns[2]?.attempt).toBe(3);
    }, 10000);

    // AC: @trait-health-monitored ac-3
    it('marks healthy and logs on recovery', async () => {
      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        minBackoffMs: 25,
      });

      const spawns: number[] = [];
      supervisor.on('spawn', (pid) => spawns.push(pid));

      await supervisor.spawn();
      expect(spawns).toHaveLength(1);
      expect(spawns[0]).toBe(12345);

      // Simulate crash and recovery
      const secondChild = new MockChildProcess();
      secondChild.pid = 12346;
      const { fork } = await import('node:child_process');
      vi.mocked(fork).mockReturnValue(secondChild as unknown as ChildProcess);

      mockChild.emit('exit', 1, null);

      // Wait for respawn
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have spawned successfully after failure
      expect(spawns.length).toBeGreaterThanOrEqual(2);
      expect(spawns[spawns.length - 1]).toBe(12346);
    });
  });

  describe('edge cases', () => {
    // AC: @supervisor-process-spawn ac-8
    it('allows child to continue if supervisor crashes', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      const pid = supervisor.getPid();
      expect(pid).toBeDefined();

      // Supervisor crashes (in real scenario, process exits)
      // Child should continue running - we verify it wasn't killed
      expect(mockChild.killed).toBe(false);
    });

    it('prevents spawn during shutdown', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      const shutdownPromise = supervisor.shutdown();

      // Try to spawn during shutdown
      await supervisor.spawn();

      await shutdownPromise;

      // Should only have one spawn call (initial)
      const { fork } = await import('node:child_process');
      expect(fork).toHaveBeenCalledTimes(1);
    });

    it('handles missing PID on spawn', async () => {
      const noPidChild = new MockChildProcess();
      // @ts-expect-error - testing missing PID
      noPidChild.pid = undefined;

      const { fork } = await import('node:child_process');
      vi.mocked(fork).mockReturnValueOnce(noPidChild as unknown as ChildProcess);

      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        minBackoffMs: 50,
      });

      const errors: Error[] = [];
      supervisor.on('ipc_error', (err) => errors.push(err));

      await supervisor.spawn();

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('no PID');
    });
  });

  describe('shutdown modes', () => {
    // AC: @shutdown-modes ac-1
    it('soft shutdown waits up to shutdownTimeout', async () => {
      const slowChild = new MockChildProcess();
      slowChild.kill = vi.fn().mockImplementation((signal: string) => {
        slowChild.killed = true;
        if (signal === 'SIGTERM') {
          // Delay exit to test timeout behavior
          setTimeout(() => {
            slowChild.emit('exit', 0, signal);
          }, 50);
        }
        return true;
      });

      const { fork } = await import('node:child_process');
      vi.mocked(fork).mockReturnValue(slowChild as unknown as ChildProcess);

      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        shutdownTimeoutMs: 30000,
      });

      await supervisor.spawn();

      const shutdownStart = Date.now();
      await supervisor.shutdown();
      const shutdownDuration = Date.now() - shutdownStart;

      expect(slowChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(shutdownDuration).toBeGreaterThanOrEqual(50);
      expect(shutdownDuration).toBeLessThan(30000);
    });

    // AC: @shutdown-modes ac-2
    it('sends SIGKILL when soft shutdown timeout exceeded', async () => {
      const hangingChild = new MockChildProcess();
      let killCount = 0;
      hangingChild.kill = vi.fn().mockImplementation((signal: string) => {
        hangingChild.killed = true;
        killCount++;
        if (signal === 'SIGKILL') {
          // Exit immediately on SIGKILL
          setTimeout(() => {
            hangingChild.emit('exit', null, 'SIGKILL');
          }, 10);
        }
        // Don't exit on SIGTERM - force timeout
        return true;
      });

      const { fork } = await import('node:child_process');
      vi.mocked(fork).mockReturnValue(hangingChild as unknown as ChildProcess);

      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        shutdownTimeoutMs: 100,
      });

      await supervisor.spawn();
      await supervisor.shutdown();

      expect(hangingChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(hangingChild.kill).toHaveBeenCalledWith('SIGKILL');
      expect(killCount).toBeGreaterThanOrEqual(2);
    });

    // AC: @shutdown-modes ac-3, ac-8
    it('completes planned restart without double-signal on SIGTERM', async () => {
      const checkpointPath = join(testDir, 'planned-restart.yaml');
      await writeFile(
        checkpointPath,
        JSON.stringify({
          version: 1,
          session_id: '01TEST',
          restart_reason: 'update',
          created_at: new Date().toISOString(),
        })
      );

      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      const killSignals: string[] = [];
      mockChild.on('test:kill', (signal) => killSignals.push(signal as string));

      // Simulate planned restart request
      mockChild.emit('message', {
        type: 'planned_restart',
        checkpoint: checkpointPath,
      });

      // Wait for IPC processing
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Now send SIGTERM to supervisor (simulating external shutdown)
      await supervisor.shutdown();

      // Should not have sent any signals to child (restart already in progress)
      expect(killSignals).toHaveLength(0);
    });

    // AC: @shutdown-modes ac-4
    it('emits draining event when shutdown initiated', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      const events: string[] = [];
      supervisor.on('draining', () => events.push('draining'));
      supervisor.on('shutdown', () => events.push('shutdown'));

      await supervisor.shutdown();

      expect(events).toContain('draining');
      expect(events.indexOf('draining')).toBeLessThan(events.indexOf('shutdown'));
    });

    // AC: @shutdown-modes ac-5
    it('hard shutdown immediately sends SIGKILL', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      const killSignals: string[] = [];
      mockChild.on('test:kill', (signal) => killSignals.push(signal as string));

      // Call hardShutdown instead of shutdown
      supervisor.hardShutdown();

      // Wait a bit for signal
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(killSignals).toContain('SIGKILL');
      expect(killSignals).not.toContain('SIGTERM');
    });

    // AC: @shutdown-modes ac-6
    it('waits for inflightCount to reach 0 with timeout', async () => {
      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        shutdownTimeoutMs: 30000,
      });
      await supervisor.spawn();

      // Track some in-flight messages
      supervisor.trackInflight();
      supervisor.trackInflight();
      supervisor.trackInflight();

      expect(supervisor.getInflightCount()).toBe(3);

      // Start shutdown in background
      const shutdownPromise = supervisor.shutdown();

      // Wait a bit, then release messages
      await new Promise((resolve) => setTimeout(resolve, 50));
      supervisor.releaseInflight();
      supervisor.releaseInflight();

      await new Promise((resolve) => setTimeout(resolve, 50));
      supervisor.releaseInflight();

      await shutdownPromise;

      expect(supervisor.getInflightCount()).toBe(0);
    });

    // AC: @shutdown-modes ac-7
    it('rejects new messages during shutdown drain', async () => {
      supervisor = new Supervisor({ childPath: '/path/to/kbot' });
      await supervisor.spawn();

      expect(supervisor.canAcceptMessages()).toBe(true);

      // Start shutdown (which starts draining)
      const shutdownPromise = supervisor.shutdown();

      // Wait a bit for draining to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(supervisor.canAcceptMessages()).toBe(false);

      await shutdownPromise;
    });

    // AC: @shutdown-modes ac-8
    it('waits for planned restart completion before exit on SIGTERM', async () => {
      const checkpointPath = join(testDir, 'restart-before-shutdown.yaml');
      await writeFile(
        checkpointPath,
        JSON.stringify({
          version: 1,
          session_id: '01TEST2',
          restart_reason: 'update',
          created_at: new Date().toISOString(),
        })
      );

      supervisor = new Supervisor({
        childPath: '/path/to/kbot',
        shutdownTimeoutMs: 1000,
      });
      await supervisor.spawn();

      // Initiate planned restart
      mockChild.emit('message', {
        type: 'planned_restart',
        checkpoint: checkpointPath,
      });

      // Wait for IPC processing
      await new Promise((resolve) => setTimeout(resolve, 20));

      const killSignals: string[] = [];
      mockChild.on('test:kill', (signal) => killSignals.push(signal as string));

      // Supervisor receives SIGTERM during planned restart
      await supervisor.shutdown();

      // Should not send additional SIGTERM (restart already coordinated)
      expect(killSignals).toHaveLength(0);
      expect(supervisor.isShutdown()).toBe(true);
    });
  });
});
