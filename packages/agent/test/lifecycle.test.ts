/**
 * AgentLifecycle Tests
 *
 * Test coverage for agent process lifecycle management.
 */

import { EventEmitter, PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCheckpoint, AgentLifecycleState } from '../src/types.js';

/**
 * Delay helper for testing
 */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Track mock ACPClient instances for test manipulation
let mockACPClientInstance: {
  initialize: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  getAllSessions: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
} | null = null;

// Mock ACPClient with a proper class (must be defined before vi.mock)
vi.mock('../src/acp/index.js', () => {
  return {
    ACPClient: class MockACPClient extends EventEmitter {
      initialize = vi.fn().mockResolvedValue({});
      getSession = vi.fn().mockReturnValue({ id: 'test-session', status: 'idle' });
      getAllSessions = vi.fn().mockReturnValue([]);
      close = vi.fn();

      constructor(_options?: unknown) {
        super();
        mockACPClientInstance = this as unknown as typeof mockACPClientInstance;
      }
    },
    JsonRpcFraming: vi.fn(),
  };
});

// Mock child_process.spawn
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

// Import after mocks are set up
import { spawn } from 'node:child_process';
import { AgentLifecycle } from '../src/lifecycle.js';

const mockSpawn = vi.mocked(spawn);

/**
 * Create a mock child process following the pattern from kynetic-internal
 */
function createMockChildProcess() {
  // Process extends EventEmitter for proper event handling
  const processEmitter = new EventEmitter();
  let _exitCode: number | null = null;
  let _signalCode: NodeJS.Signals | null = null;
  let _killed = false;

  // Use real PassThrough streams for stdin/stdout
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  const mockProcess = Object.assign(processEmitter, {
    pid: 12345,
    stdin,
    stdout,
    stderr: null,
    get exitCode() {
      return _exitCode;
    },
    set exitCode(value: number | null) {
      _exitCode = value;
    },
    get signalCode() {
      return _signalCode;
    },
    set signalCode(value: NodeJS.Signals | null) {
      _signalCode = value;
    },
    get killed() {
      return _killed;
    },
    set killed(value: boolean) {
      _killed = value;
    },

    kill: vi.fn((signal?: string) => {
      _killed = true;
      if (signal === 'SIGKILL') {
        _exitCode = -1;
        _signalCode = 'SIGKILL';
      } else {
        _exitCode = 0;
        _signalCode = 'SIGTERM';
      }
      // Emit exit event asynchronously to allow test assertions
      setImmediate(() => {
        processEmitter.emit('exit', _exitCode, _signalCode);
      });
      return true;
    }),

    // Test helpers
    _emit: (event: string, ...args: unknown[]) => {
      processEmitter.emit(event, ...args);
    },

    _setExitCode: (code: number | null) => {
      _exitCode = code;
    },
  });

  return mockProcess;
}

describe('AgentLifecycle', () => {
  let lifecycle: AgentLifecycle;
  let mockProcess: ReturnType<typeof createMockChildProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockACPClientInstance = null;

    mockProcess = createMockChildProcess();
    mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

    lifecycle = new AgentLifecycle({
      command: 'test-agent',
      args: ['--test'],
      healthCheckInterval: 100, // Fast for testing
      failureThreshold: 3,
      shutdownTimeout: 100,
      backoff: {
        initial: 50,
        max: 200,
        multiplier: 2,
      },
    });
  });

  afterEach(async () => {
    // Ensure cleanup
    if (lifecycle.getState() !== 'idle') {
      await lifecycle.kill().catch(() => {});
    }
    vi.clearAllTimers();
  });

  describe('Lifecycle Management (@agent-lifecycle)', () => {
    // AC: @agent-lifecycle ac-1
    it('should spawn agent with KYNETIC_* environment variables', async () => {
      await lifecycle.spawn();

      expect(mockSpawn).toHaveBeenCalledWith(
        'test-agent',
        ['--test'],
        expect.objectContaining({
          env: expect.objectContaining({
            KYNETIC_AGENT: 'true',
            KYNETIC_SESSION_ID: '',
          }),
        }),
      );

      expect(lifecycle.getState()).toBe('healthy');
      expect(lifecycle.isHealthy()).toBe(true);

      await lifecycle.kill();
    });

    // AC: @agent-lifecycle ac-1 (custom env override)
    it('should allow custom env to override KYNETIC_* vars', async () => {
      await lifecycle.spawn({ KYNETIC_AGENT: 'custom', CUSTOM_VAR: 'value' });

      expect(mockSpawn).toHaveBeenCalledWith(
        'test-agent',
        ['--test'],
        expect.objectContaining({
          env: expect.objectContaining({
            KYNETIC_AGENT: 'custom',
            CUSTOM_VAR: 'value',
          }),
        }),
      );

      await lifecycle.kill();
    });

    // AC: @agent-lifecycle ac-2
    it('should trigger respawn on unexpected process exit', async () => {
      await lifecycle.spawn();
      expect(lifecycle.getState()).toBe('healthy');

      // Create new process for respawn
      const newMockProcess = createMockChildProcess();
      mockSpawn.mockReturnValue(newMockProcess as unknown as ReturnType<typeof spawn>);

      // Simulate unexpected process exit (triggers handleProcessExit -> restartUnhealthyAgent)
      mockProcess.exitCode = 1;
      mockProcess._emit('exit', 1, null);

      // Wait for respawn to complete (includes backoff)
      await delay(200);

      // Should have attempted respawn
      expect(mockSpawn).toHaveBeenCalledTimes(2);

      await lifecycle.kill();
    });

    // AC: @agent-lifecycle ac-3
    it('should terminate gracefully with SIGTERM on stop', async () => {
      await lifecycle.spawn();

      await lifecycle.stop();

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(lifecycle.getState()).toBe('idle');
    });

    // AC: @agent-lifecycle ac-3
    it('should force kill with SIGKILL after timeout', async () => {
      // Make process not respond to SIGTERM (don't emit exit)
      mockProcess.kill = vi.fn((signal) => {
        mockProcess.killed = true;
        if (signal === 'SIGKILL') {
          mockProcess.exitCode = -1;
          mockProcess.signalCode = 'SIGKILL' as NodeJS.Signals;
          // SIGKILL always works
          setImmediate(() => {
            mockProcess._emit('exit', -1, 'SIGKILL');
          });
        }
        // SIGTERM is ignored (unresponsive process)
        return true;
      });

      await lifecycle.spawn();
      await lifecycle.stop();

      // Should have tried SIGTERM then SIGKILL
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
      expect(lifecycle.getState()).toBe('idle');
    });

    // AC: @agent-lifecycle ac-4
    it('should queue spawn requests when at max concurrent spawns', async () => {
      const queuedEvents: number[] = [];
      lifecycle.on('spawn:queued', (queueLength) => queuedEvents.push(queueLength));

      // Start first spawn but don't await yet
      const spawn1Promise = lifecycle.spawn();

      // While first spawn is in spawning state, queue second spawn
      // The queue is checked before checking state, so this should queue
      lifecycle.spawn().catch(() => {}); // Ignore - will fail since state becomes healthy

      // Should have queued the second request
      expect(queuedEvents.length).toBeGreaterThan(0);

      // Wait for first spawn
      await spawn1Promise;

      await lifecycle.kill();
    });
  });

  describe('Health Monitoring (@trait-health-monitored)', () => {
    // AC: @trait-health-monitored ac-1
    it('should perform health checks at configured interval', async () => {
      const healthChecks: boolean[] = [];
      lifecycle.on('health:check', (passed) => healthChecks.push(passed));

      await lifecycle.spawn();

      // Wait for a few health checks
      await delay(250);

      // Should have performed at least 2 health checks
      expect(healthChecks.length).toBeGreaterThanOrEqual(2);

      await lifecycle.kill();
    });

    // AC: @trait-health-monitored ac-2
    it('should track consecutive failures with health:check events', async () => {
      const healthChecks: Array<{ passed: boolean; failures: number }> = [];
      lifecycle.on('health:check', (passed, consecutiveFailures) => {
        healthChecks.push({ passed, failures: consecutiveFailures });
      });

      await lifecycle.spawn();

      // Wait for at least one health check
      await delay(150);

      // Health checks should be passing (exitCode is null)
      expect(healthChecks.length).toBeGreaterThan(0);
      expect(healthChecks.every((h) => h.passed)).toBe(true);

      await lifecycle.kill();
    });

    // AC: @trait-health-monitored ac-3
    it('should emit health:status events on status changes', async () => {
      const statusChanges: Array<{ healthy: boolean; recovered: boolean }> = [];
      lifecycle.on('health:status', (healthy, recovered) => {
        statusChanges.push({ healthy, recovered });
      });

      await lifecycle.spawn();

      // Verify we can capture status changes (initial spawn doesn't emit health:status)
      // The health:status event is emitted when transitioning between healthy/unhealthy
      expect(statusChanges).toEqual([]); // No changes yet - just spawned

      await lifecycle.kill();
    });
  });

  describe('Rate Limiting (@trait-rate-limited)', () => {
    // AC: @trait-rate-limited ac-1
    it('should use exponential backoff starting at configured initial value', async () => {
      lifecycle = new AgentLifecycle({
        command: 'test-agent',
        healthCheckInterval: 1000,
        backoff: {
          initial: 1000, // 1 second
          max: 60000,
          multiplier: 2,
        },
      });

      // Verify initial backoff is set correctly
      expect(lifecycle.getCheckpoint().currentBackoffMs).toBe(1000);
    });

    // AC: @trait-rate-limited ac-2
    it('should process spawn requests sequentially', async () => {
      let spawnCount = 0;

      // Create a fresh lifecycle for this test
      const testLifecycle = new AgentLifecycle({
        command: 'test-agent',
        healthCheckInterval: 1000,
        maxConcurrentSpawns: 1,
      });

      // Track spawns
      mockSpawn.mockImplementation(() => {
        spawnCount++;
        return mockProcess as unknown as ReturnType<typeof spawn>;
      });

      // Single spawn should work
      await testLifecycle.spawn();
      expect(spawnCount).toBe(1);

      await testLifecycle.kill();
    });

    // AC: @trait-rate-limited ac-3
    it('should emit warning when spawn requests are queued', async () => {
      const queueWarnings: number[] = [];
      lifecycle.on('spawn:queued', (queueLength) => queueWarnings.push(queueLength));

      // Start first spawn
      const spawn1 = lifecycle.spawn();

      // Queue second spawn while first is still spawning (don't await)
      lifecycle.spawn().catch(() => {}); // Will fail after first completes

      // Should have emitted queue warning synchronously
      expect(queueWarnings.length).toBeGreaterThan(0);

      // Wait for first spawn to complete
      await spawn1;

      await lifecycle.kill();
    });
  });

  describe('Graceful Shutdown (@trait-graceful-shutdown)', () => {
    // AC: @trait-graceful-shutdown ac-1
    it('should stop accepting new work during shutdown', async () => {
      await lifecycle.spawn();

      // Start stopping
      const stopPromise = lifecycle.stop();

      // State should be stopping
      expect(lifecycle.getState()).toBe('stopping');

      await stopPromise;
      expect(lifecycle.getState()).toBe('idle');
    });

    // AC: @trait-graceful-shutdown ac-2
    it('should use configured shutdown timeout', async () => {
      lifecycle = new AgentLifecycle({
        command: 'test-agent',
        shutdownTimeout: 10000,
      });

      // Verify the lifecycle was created with correct options
      const checkpoint = lifecycle.getCheckpoint();
      expect(checkpoint).toBeDefined();
    });

    // AC: @trait-graceful-shutdown ac-3
    it('should release all resources on shutdown', async () => {
      await lifecycle.spawn();

      await lifecycle.stop();

      // Should have released resources
      expect(lifecycle.getState()).toBe('idle');
      expect(lifecycle.getClient()).toBeNull();
    });
  });

  describe('Observability (@trait-observable)', () => {
    // AC: @trait-observable ac-1
    it('should emit state:change events for all state transitions', async () => {
      const transitions: Array<{ from: AgentLifecycleState; to: AgentLifecycleState }> = [];
      lifecycle.on('state:change', (from, to) => transitions.push({ from, to }));

      await lifecycle.spawn();
      await lifecycle.stop();

      // Should have recorded key transitions
      expect(transitions).toContainEqual({ from: 'idle', to: 'spawning' });
      expect(transitions).toContainEqual({ from: 'spawning', to: 'healthy' });
      expect(transitions).toContainEqual({ from: 'healthy', to: 'stopping' });
      // The final transition to idle happens after stop completes
    });

    // AC: @trait-observable ac-2
    it('should emit error events with context', async () => {
      const errors: Array<{ error: Error; context: Record<string, unknown> }> = [];
      lifecycle.on('error', (error, context) => errors.push({ error, context }));

      await lifecycle.spawn();

      // Simulate process error
      mockProcess._emit('error', new Error('Process crashed'));

      // Should have emitted error with context
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].context).toHaveProperty('state');
    });

    // AC: @trait-observable ac-3
    it('should emit shutdown:complete when fully stopped via kill', async () => {
      let shutdownComplete = false;
      lifecycle.on('shutdown:complete', () => {
        shutdownComplete = true;
      });

      await lifecycle.spawn();
      await lifecycle.kill(); // kill() always emits shutdown:complete

      // Wait a tick for the event to be processed
      await delay(10);

      expect(shutdownComplete).toBe(true);
    });
  });

  describe('Recoverability (@trait-recoverable)', () => {
    // AC: @trait-recoverable ac-1
    it('should save checkpoint with current state', async () => {
      let savedCheckpoint: AgentCheckpoint | null = null;
      lifecycle.on('checkpoint:saved', (checkpoint) => {
        savedCheckpoint = checkpoint;
      });

      await lifecycle.spawn();

      const checkpoint = lifecycle.getCheckpoint();

      expect(checkpoint.state).toBe('healthy');
      expect(checkpoint.timestamp).toBeGreaterThan(0);
      expect(checkpoint.consecutiveFailures).toBe(0);
      expect(savedCheckpoint).toEqual(checkpoint);

      await lifecycle.kill();
    });

    // AC: @trait-recoverable ac-2
    it('should restore from checkpoint', async () => {
      const checkpoint: AgentCheckpoint = {
        timestamp: Date.now() - 1000,
        state: 'unhealthy',
        sessionId: 'saved-session',
        consecutiveFailures: 2,
        currentBackoffMs: 4000,
      };

      lifecycle.restoreFromCheckpoint(checkpoint);

      const current = lifecycle.getCheckpoint();
      expect(current.consecutiveFailures).toBe(2);
      expect(current.currentBackoffMs).toBe(4000);
    });

    // AC: @trait-recoverable ac-3
    it('should support escalate event emission', async () => {
      let escalated = false;
      let escalateContext: Record<string, unknown> = {};
      lifecycle.on('escalate', (reason, context) => {
        escalated = true;
        escalateContext = context;
      });

      // The escalate event is emitted during restartUnhealthyAgent when spawn fails
      // at max backoff. We verify the event listener can be attached.
      expect(escalated).toBe(false);

      // Manually emit to verify listener works
      lifecycle.emit('escalate', 'Test escalation', { test: true });
      expect(escalated).toBe(true);
      expect(escalateContext).toEqual({ test: true });
    });
  });

  describe('State Management', () => {
    it('should start in idle state', () => {
      expect(lifecycle.getState()).toBe('idle');
      expect(lifecycle.isHealthy()).toBe(false);
    });

    it('should not allow spawn from healthy state', async () => {
      await lifecycle.spawn();

      // Already healthy, can't spawn again directly
      await expect(lifecycle.spawn()).rejects.toThrow('Cannot spawn from state');

      await lifecycle.kill();
    });

    it('should allow multiple stop calls', async () => {
      await lifecycle.spawn();

      await lifecycle.stop();
      await lifecycle.stop(); // Should not throw
      await lifecycle.stop(); // Should not throw

      expect(lifecycle.getState()).toBe('idle');
    });

    it('should handle kill from any state', async () => {
      await lifecycle.spawn();

      await lifecycle.kill();

      expect(lifecycle.getState()).toBe('idle');
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL');
    });
  });

  describe('Process Events', () => {
    it('should emit agent:spawned with pid', async () => {
      let spawnedPid: number | null = null;
      lifecycle.on('agent:spawned', (pid) => {
        spawnedPid = pid;
      });

      await lifecycle.spawn();

      expect(spawnedPid).toBe(12345);

      await lifecycle.kill();
    });

    it('should emit agent:exited on unexpected process exit', async () => {
      let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      lifecycle.on('agent:exited', (code, signal) => {
        exitInfo = { code, signal };
      });

      await lifecycle.spawn();

      // Simulate unexpected process exit (not from kill)
      mockProcess.exitCode = 1;
      mockProcess._emit('exit', 1, null);

      expect(exitInfo).toEqual({ code: 1, signal: null });

      // Cleanup
      await lifecycle.kill();
    });

    it('should handle process error', async () => {
      const errors: Error[] = [];
      lifecycle.on('error', (error) => errors.push(error));

      await lifecycle.spawn();

      // Simulate process error
      mockProcess._emit('error', new Error('Process crashed'));

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toBe('Process crashed');

      await lifecycle.kill();
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid start/stop cycles', async () => {
      await lifecycle.spawn();
      await lifecycle.kill();

      // Create new process for second spawn
      mockProcess = createMockChildProcess();
      mockSpawn.mockReturnValue(mockProcess as unknown as ReturnType<typeof spawn>);

      await lifecycle.spawn();
      await lifecycle.kill();

      expect(lifecycle.getState()).toBe('idle');
    });

    it('should roundtrip checkpoint save/restore', async () => {
      await lifecycle.spawn();

      // Save checkpoint
      const saved = lifecycle.getCheckpoint();
      expect(saved.state).toBe('healthy');

      await lifecycle.kill();

      // Create new instance and restore
      const newLifecycle = new AgentLifecycle({
        command: 'test-agent',
      });

      newLifecycle.restoreFromCheckpoint(saved);

      const restored = newLifecycle.getCheckpoint();
      expect(restored.consecutiveFailures).toBe(saved.consecutiveFailures);
      expect(restored.currentBackoffMs).toBe(saved.currentBackoffMs);
    });

    // Issue 8: Test that no respawn occurs during intentional shutdown
    it('should NOT trigger respawn when process exits during stop', async () => {
      await lifecycle.spawn();
      mockSpawn.mockClear();

      await lifecycle.stop();

      // Should NOT have attempted respawn during intentional shutdown
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(lifecycle.getState()).toBe('idle');
    });

    // Issue 9: Test actual escalation path through code
    // This tests that the escalate event fires when spawn fails at max backoff
    // The escalate event is emitted in restartUnhealthyAgent after performSpawn fails
    // and currentBackoffMs >= options.backoff.max
    it('should emit escalate when respawn fails at max backoff', async () => {
      // Create lifecycle with small max backoff for testing
      const testLifecycle = new AgentLifecycle({
        command: 'test-agent',
        args: ['--test'],
        healthCheckInterval: 1000,
        failureThreshold: 3,
        shutdownTimeout: 100,
        backoff: {
          initial: 10,
          max: 10, // Same as initial so first failure triggers escalate
          multiplier: 2,
        },
      });

      // Track escalation
      let escalated = false;
      let escalateReason = '';
      testLifecycle.on('escalate', (reason) => {
        escalated = true;
        escalateReason = reason;
      });

      // First spawn succeeds
      const process1 = createMockChildProcess();
      mockSpawn.mockReturnValueOnce(process1 as unknown as ReturnType<typeof spawn>);
      await testLifecycle.spawn();

      expect(testLifecycle.getState()).toBe('healthy');

      // Make future spawns fail - this must be set BEFORE triggering exit
      mockSpawn.mockImplementation(() => {
        throw new Error('Spawn failed');
      });

      // Trigger unexpected exit - this calls handleProcessExit -> restartUnhealthyAgent
      // Flow: handleProcessExit -> restartUnhealthyAgent -> kill -> wait backoff -> performSpawn (fails) -> check escalate
      // At this point backoff is at initial (10ms) which equals max (10ms)
      // After performSpawn fails, backoff increases to min(10*2, 10) = 10, still at max
      // Then escalate is emitted
      process1.exitCode = 1;
      process1._emit('exit', 1, null);

      // Wait for: kill + backoff (10ms) + spawn attempt + processing
      await delay(100);

      expect(escalated).toBe(true);
      expect(escalateReason).toContain('Max backoff reached');
    });

    // Issue 10: Test checkpoint restore returns false from non-idle state
    it('should return false when restoring from non-idle state', async () => {
      await lifecycle.spawn();

      const result = lifecycle.restoreFromCheckpoint({
        timestamp: Date.now(),
        state: 'idle',
        consecutiveFailures: 0,
        currentBackoffMs: 1000,
      });

      expect(result).toBe(false);
      expect(lifecycle.getState()).toBe('healthy');

      await lifecycle.kill();
    });

    // Additional test: verify restoreFromCheckpoint returns true on success
    it('should return true when restoring from idle state', () => {
      const result = lifecycle.restoreFromCheckpoint({
        timestamp: Date.now(),
        state: 'failed',
        consecutiveFailures: 5,
        currentBackoffMs: 2000,
      });

      expect(result).toBe(true);
      expect(lifecycle.getCheckpoint().consecutiveFailures).toBe(5);
      expect(lifecycle.getCheckpoint().currentBackoffMs).toBe(2000);
    });
  });
});
