/**
 * EscalationHandler Tests
 *
 * Test coverage for human escalation path handling.
 *
 * @see @agent-escalation
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EscalationHandler,
  EscalationError,
  EscalationNotFoundError,
  EscalationAlreadyAcknowledgedError,
  type EscalationConfig,
  type EscalationRecord,
  type EscalationFallback,
} from '../src/escalation.js';
import type { AgentLifecycle, AgentCheckpoint } from '../src/index.js';

/**
 * Delay helper for testing
 */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a mock AgentLifecycle that emits events
 */
function createMockLifecycle(): AgentLifecycle & EventEmitter {
  const emitter = new EventEmitter();

  const mockLifecycle = Object.assign(emitter, {
    spawn: vi.fn(),
    stop: vi.fn(),
    kill: vi.fn(),
    getState: vi.fn().mockReturnValue('failed'),
    isHealthy: vi.fn().mockReturnValue(false),
    getClient: vi.fn().mockReturnValue(null),
    getSessionId: vi.fn().mockReturnValue('test-session'),
    getCheckpoint: vi.fn().mockReturnValue({
      timestamp: Date.now(),
      state: 'failed',
      sessionId: 'test-session',
      consecutiveFailures: 5,
      currentBackoffMs: 60000,
    } as AgentCheckpoint),
    restoreFromCheckpoint: vi.fn().mockReturnValue(true),
  });

  return mockLifecycle as unknown as AgentLifecycle & EventEmitter;
}

describe('EscalationHandler', () => {
  let handler: EscalationHandler;
  let mockLifecycle: AgentLifecycle & EventEmitter;

  const defaultConfig: EscalationConfig = {
    notificationChannels: ['console'],
    timeoutMs: 100, // Short timeout for tests
    fallback: 'retry',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockLifecycle = createMockLifecycle();
    handler = new EscalationHandler({ config: defaultConfig });
    handler.attach(mockLifecycle);
  });

  afterEach(() => {
    handler.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Error Classes
  // ==========================================================================

  describe('Error Classes', () => {
    it('EscalationError has correct structure', () => {
      const error = new EscalationError('test', 'CODE', 'esc_123');
      expect(error.message).toBe('test');
      expect(error.code).toBe('ESCALATION_CODE');
      expect(error.escalationId).toBe('esc_123');
    });

    it('EscalationNotFoundError includes escalation ID', () => {
      const error = new EscalationNotFoundError('esc_123');
      expect(error.message).toContain('esc_123');
      expect(error.code).toBe('ESCALATION_NOT_FOUND');
      expect(error.escalationId).toBe('esc_123');
    });

    it('EscalationAlreadyAcknowledgedError includes escalation ID', () => {
      const error = new EscalationAlreadyAcknowledgedError('esc_456');
      expect(error.message).toContain('esc_456');
      expect(error.code).toBe('ESCALATION_ALREADY_ACKNOWLEDGED');
      expect(error.escalationId).toBe('esc_456');
    });
  });

  // ==========================================================================
  // Lifecycle Integration
  // ==========================================================================

  describe('Lifecycle Integration', () => {
    it('attaches to AgentLifecycle', () => {
      expect(handler.getLifecycle()).toBe(mockLifecycle);
    });

    it('detaches from AgentLifecycle', () => {
      handler.detach();
      expect(handler.getLifecycle()).toBeNull();
    });

    it('reattaches when attach called again', () => {
      const newLifecycle = createMockLifecycle();
      handler.attach(newLifecycle);
      expect(handler.getLifecycle()).toBe(newLifecycle);
    });

    it('handles escalate event from lifecycle', () => {
      const notifiedHandler = vi.fn();
      handler.on('escalation:notified', notifiedHandler);

      mockLifecycle.emit('escalate', 'Max backoff reached', {
        backoffMs: 60000,
        consecutiveFailures: 5,
      });

      expect(notifiedHandler).toHaveBeenCalled();
      const record = notifiedHandler.mock.calls[0][0] as EscalationRecord;
      expect(record.reason).toBe('Max backoff reached');
      expect(record.context.backoffMs).toBe(60000);
      expect(record.state).toBe('pending');
    });

    it('does not handle events after detach', () => {
      const notifiedHandler = vi.fn();
      handler.on('escalation:notified', notifiedHandler);

      handler.detach();
      mockLifecycle.emit('escalate', 'Should not be handled', {});

      expect(notifiedHandler).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // AC-1: Escalation Notification
  // ==========================================================================

  describe('AC-1: Escalation Notification', () => {
    // AC: @agent-escalation ac-1 - notifies configured human contacts with context
    it('creates escalation record on escalate event', () => {
      mockLifecycle.emit('escalate', 'Unrecoverable error', { errorCode: 'E500' });

      const escalations = handler.getAllEscalations();
      expect(escalations).toHaveLength(1);
      expect(escalations[0].reason).toBe('Unrecoverable error');
      expect(escalations[0].context).toEqual({ errorCode: 'E500' });
    });

    // AC: @agent-escalation ac-1 - context includes checkpoint
    it('includes checkpoint in escalation record', () => {
      mockLifecycle.emit('escalate', 'Failure', {});

      const escalation = handler.getAllEscalations()[0];
      expect(escalation.checkpoint).toBeDefined();
      expect(escalation.checkpoint?.state).toBe('failed');
      expect(escalation.checkpoint?.consecutiveFailures).toBe(5);
    });

    // AC: @agent-escalation ac-1 - notifies via console channel
    it('notifies via console channel', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockLifecycle.emit('escalate', 'Test escalation', { detail: 'test' });

      // Logger uses console.error for error level
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('emits escalation:notified event', () => {
      const handler = vi.fn();
      (globalThis as { handler: typeof handler }).handler = handler;
      const notifiedHandler = vi.fn();
      const newHandler = new EscalationHandler({ config: defaultConfig });
      newHandler.on('escalation:notified', notifiedHandler);
      newHandler.attach(mockLifecycle);

      mockLifecycle.emit('escalate', 'Error', {});

      expect(notifiedHandler).toHaveBeenCalled();
      newHandler.dispose();
    });

    it('generates unique escalation IDs', () => {
      mockLifecycle.emit('escalate', 'First', {});
      mockLifecycle.emit('escalate', 'Second', {});

      const escalations = handler.getAllEscalations();
      expect(escalations).toHaveLength(2);
      expect(escalations[0].id).not.toBe(escalations[1].id);
    });

    it('sets triggeredAt timestamp', () => {
      const now = Date.now();
      mockLifecycle.emit('escalate', 'Error', {});

      const escalation = handler.getAllEscalations()[0];
      expect(escalation.triggeredAt).toBeGreaterThanOrEqual(now);
    });
  });

  // ==========================================================================
  // AC-2: Human Acknowledgment
  // ==========================================================================

  describe('AC-2: Human Acknowledgment', () => {
    let escalationId: string;

    beforeEach(() => {
      mockLifecycle.emit('escalate', 'Test error', { data: 'test' });
      escalationId = handler.getAllEscalations()[0].id;
    });

    // AC: @agent-escalation ac-2 - agent pauses on acknowledgment
    it('transitions to acknowledged state', async () => {
      await handler.acknowledge(escalationId, 'human@test.com');

      const escalation = handler.getEscalation(escalationId);
      expect(escalation?.state).toBe('acknowledged');
    });

    // AC: @agent-escalation ac-2 - provides conversation handoff
    it('records acknowledgedAt and acknowledgedBy', async () => {
      const beforeAck = Date.now();
      await handler.acknowledge(escalationId, 'support@company.com');

      const escalation = handler.getEscalation(escalationId);
      expect(escalation?.acknowledgedAt).toBeGreaterThanOrEqual(beforeAck);
      expect(escalation?.acknowledgedBy).toBe('support@company.com');
    });

    it('emits escalation:acknowledged event', async () => {
      const acknowledgedHandler = vi.fn();
      handler.on('escalation:acknowledged', acknowledgedHandler);

      await handler.acknowledge(escalationId, 'human');

      expect(acknowledgedHandler).toHaveBeenCalled();
      const [record, humanId] = acknowledgedHandler.mock.calls[0];
      expect(record.id).toBe(escalationId);
      expect(humanId).toBe('human');
    });

    it('emits state:change event on acknowledgment', async () => {
      const stateChangeHandler = vi.fn();
      handler.on('state:change', stateChangeHandler);

      await handler.acknowledge(escalationId);

      expect(stateChangeHandler).toHaveBeenCalledWith(
        escalationId,
        'pending',
        'acknowledged',
      );
    });

    it('cancels timeout timer on acknowledgment', async () => {
      const timeoutHandler = vi.fn();
      handler.on('escalation:timeout', timeoutHandler);

      await handler.acknowledge(escalationId);

      // Advance time past timeout
      vi.advanceTimersByTime(200);

      expect(timeoutHandler).not.toHaveBeenCalled();
    });

    it('throws EscalationNotFoundError for unknown ID', async () => {
      await expect(handler.acknowledge('unknown_id')).rejects.toThrow(
        EscalationNotFoundError,
      );
    });

    it('throws EscalationAlreadyAcknowledgedError for double acknowledgment', async () => {
      await handler.acknowledge(escalationId);

      await expect(handler.acknowledge(escalationId)).rejects.toThrow(
        EscalationAlreadyAcknowledgedError,
      );
    });

    // AC: @agent-escalation ac-2 - provides conversation handoff context
    it('provides handoff context after acknowledgment', async () => {
      await handler.acknowledge(escalationId, 'human');

      const handoff = handler.getHandoffContext(escalationId);
      expect(handoff).not.toBeNull();
      expect(handoff?.record.id).toBe(escalationId);
      expect(handoff?.checkpoint).toBeDefined();
    });

    it('returns null handoff context for non-acknowledged escalation', () => {
      const handoff = handler.getHandoffContext(escalationId);
      expect(handoff).toBeNull();
    });

    it('allows late acknowledgment after timeout', async () => {
      // Let timeout occur
      vi.advanceTimersByTime(200);

      // Should not throw
      await expect(
        handler.acknowledge(escalationId, 'late_human'),
      ).resolves.toBeUndefined();

      const escalation = handler.getEscalation(escalationId);
      expect(escalation?.state).toBe('acknowledged');
    });
  });

  // ==========================================================================
  // AC-3: Timeout Fallback
  // ==========================================================================

  describe('AC-3: Timeout Fallback', () => {
    // AC: @agent-escalation ac-3 - follows configured fallback behavior
    it('transitions to timeout state after timeoutMs', () => {
      mockLifecycle.emit('escalate', 'Error', {});
      const escalationId = handler.getAllEscalations()[0].id;

      vi.advanceTimersByTime(100);

      const escalation = handler.getEscalation(escalationId);
      expect(escalation?.state).toBe('timeout');
    });

    it('emits escalation:timeout event', () => {
      const timeoutHandler = vi.fn();
      handler.on('escalation:timeout', timeoutHandler);

      mockLifecycle.emit('escalate', 'Error', {});
      vi.advanceTimersByTime(100);

      expect(timeoutHandler).toHaveBeenCalled();
    });

    it('emits state:change on timeout', () => {
      const stateChangeHandler = vi.fn();
      handler.on('state:change', stateChangeHandler);

      mockLifecycle.emit('escalate', 'Error', {});
      vi.advanceTimersByTime(100);

      expect(stateChangeHandler).toHaveBeenCalledWith(
        expect.any(String),
        'pending',
        'timeout',
      );
    });

    // AC: @agent-escalation ac-3 - executes fallback behavior
    it('emits escalation:fallback with fallback type', () => {
      const fallbackHandler = vi.fn();
      handler.on('escalation:fallback', fallbackHandler);

      mockLifecycle.emit('escalate', 'Error', {});
      vi.advanceTimersByTime(100);

      expect(fallbackHandler).toHaveBeenCalled();
      const [record, fallback] = fallbackHandler.mock.calls[0];
      expect(fallback).toBe('retry');
    });

    it('respects configured fallback type: pause', () => {
      handler.dispose();
      handler = new EscalationHandler({
        config: { ...defaultConfig, fallback: 'pause' },
      });
      handler.attach(mockLifecycle);

      const fallbackHandler = vi.fn();
      handler.on('escalation:fallback', fallbackHandler);

      mockLifecycle.emit('escalate', 'Error', {});
      vi.advanceTimersByTime(100);

      const [, fallback] = fallbackHandler.mock.calls[0];
      expect(fallback).toBe('pause');
    });

    it('respects configured fallback type: fail', () => {
      handler.dispose();
      handler = new EscalationHandler({
        config: { ...defaultConfig, fallback: 'fail' },
      });
      handler.attach(mockLifecycle);

      const fallbackHandler = vi.fn();
      handler.on('escalation:fallback', fallbackHandler);

      mockLifecycle.emit('escalate', 'Error', {});
      vi.advanceTimersByTime(100);

      const [, fallback] = fallbackHandler.mock.calls[0];
      expect(fallback).toBe('fail');
    });

    it('does not timeout if already acknowledged', async () => {
      mockLifecycle.emit('escalate', 'Error', {});
      const escalationId = handler.getAllEscalations()[0].id;

      await handler.acknowledge(escalationId);

      const timeoutHandler = vi.fn();
      handler.on('escalation:timeout', timeoutHandler);

      vi.advanceTimersByTime(200);

      expect(timeoutHandler).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Observable Trait
  // ==========================================================================

  describe('@trait-observable', () => {
    // AC: @trait-observable ac-1 - emits structured event on state change
    it('emits structured state:change events', () => {
      const stateChangeHandler = vi.fn();
      handler.on('state:change', stateChangeHandler);

      mockLifecycle.emit('escalate', 'Error', {});
      vi.advanceTimersByTime(100);

      expect(stateChangeHandler).toHaveBeenCalledWith(
        expect.any(String),
        'pending',
        'timeout',
      );
    });

    // AC: @trait-observable ac-2 - logs with context
    it('logs with context on escalation', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockLifecycle.emit('escalate', 'Test error', { key: 'value' });

      // Logger outputs via console
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // AC: @trait-observable ac-3 - emits completion event for significant operations
    it('emits completion event when escalation acknowledged', async () => {
      const acknowledgedHandler = vi.fn();
      handler.on('escalation:acknowledged', acknowledgedHandler);

      mockLifecycle.emit('escalate', 'Error', {});
      const escalationId = handler.getAllEscalations()[0].id;

      await handler.acknowledge(escalationId, 'human');

      // escalation:acknowledged serves as the completion event
      expect(acknowledgedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ id: escalationId, state: 'acknowledged' }),
        'human',
      );
    });

    // AC: @trait-observable ac-3 - emits completion event for fallback execution
    it('emits completion event when fallback executed', () => {
      const fallbackHandler = vi.fn();
      handler.on('escalation:fallback', fallbackHandler);

      mockLifecycle.emit('escalate', 'Error', {});
      vi.advanceTimersByTime(100);

      // escalation:fallback serves as the completion event for timeout handling
      expect(fallbackHandler).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'timeout' }),
        'retry',
      );
    });
  });

  // ==========================================================================
  // State & Query
  // ==========================================================================

  describe('State & Query', () => {
    it('getEscalation returns record by ID', () => {
      mockLifecycle.emit('escalate', 'Error', {});
      const escalationId = handler.getAllEscalations()[0].id;

      const escalation = handler.getEscalation(escalationId);
      expect(escalation).toBeDefined();
      expect(escalation?.id).toBe(escalationId);
    });

    it('getEscalation returns undefined for unknown ID', () => {
      expect(handler.getEscalation('unknown')).toBeUndefined();
    });

    it('getPendingEscalations returns only pending', async () => {
      mockLifecycle.emit('escalate', 'Error 1', {});
      mockLifecycle.emit('escalate', 'Error 2', {});
      const escalationId = handler.getAllEscalations()[0].id;

      await handler.acknowledge(escalationId);

      const pending = handler.getPendingEscalations();
      expect(pending).toHaveLength(1);
      expect(pending[0].reason).toBe('Error 2');
    });

    it('getAllEscalations returns all', async () => {
      mockLifecycle.emit('escalate', 'Error 1', {});
      mockLifecycle.emit('escalate', 'Error 2', {});

      expect(handler.getAllEscalations()).toHaveLength(2);
    });

    it('hasActiveEscalation returns true when pending exists', () => {
      mockLifecycle.emit('escalate', 'Error', {});
      expect(handler.hasActiveEscalation()).toBe(true);
    });

    it('hasActiveEscalation returns false when none pending', async () => {
      mockLifecycle.emit('escalate', 'Error', {});
      const id = handler.getAllEscalations()[0].id;
      await handler.acknowledge(id);

      expect(handler.hasActiveEscalation()).toBe(false);
    });

    it('clearResolvedEscalations removes acknowledged and timed out', async () => {
      // Create handler with longer timeout so we can control timing
      handler.dispose();
      handler = new EscalationHandler({
        config: { ...defaultConfig, timeoutMs: 500 },
      });
      handler.attach(mockLifecycle);

      // Create first two escalations
      mockLifecycle.emit('escalate', 'Error 1', {});
      mockLifecycle.emit('escalate', 'Error 2', {});

      const [esc1, esc2] = handler.getAllEscalations();

      // Acknowledge first immediately (cancels its timeout)
      await handler.acknowledge(esc1.id);

      // Wait 400ms - second not yet timed out (needs 500ms)
      vi.advanceTimersByTime(400);

      // Create third escalation (has fresh 500ms timer)
      mockLifecycle.emit('escalate', 'Error 3', {});

      // Wait 100ms more - second times out (500ms total), third still pending (100ms)
      vi.advanceTimersByTime(100);

      // Now: esc1=acknowledged, esc2=timeout, esc3=pending (100ms elapsed)

      const cleared = handler.clearResolvedEscalations();
      expect(cleared).toBe(2);
      expect(handler.getAllEscalations()).toHaveLength(1);
      expect(handler.getAllEscalations()[0].reason).toBe('Error 3');
    });
  });

  // ==========================================================================
  // Configuration
  // ==========================================================================

  describe('Configuration', () => {
    it('uses default timeout of 5 minutes', () => {
      handler.dispose();
      handler = new EscalationHandler({
        config: { notificationChannels: ['console'] },
      });
      handler.attach(mockLifecycle);

      mockLifecycle.emit('escalate', 'Error', {});

      // Not timed out after 4 minutes
      vi.advanceTimersByTime(240000);
      expect(handler.getAllEscalations()[0].state).toBe('pending');

      // Timed out after 5 minutes total
      vi.advanceTimersByTime(60001);
      expect(handler.getAllEscalations()[0].state).toBe('timeout');
    });

    it('uses default fallback of retry', () => {
      handler.dispose();
      handler = new EscalationHandler({
        config: { notificationChannels: ['console'] },
      });
      handler.attach(mockLifecycle);

      const fallbackHandler = vi.fn();
      handler.on('escalation:fallback', fallbackHandler);

      mockLifecycle.emit('escalate', 'Error', {});
      vi.advanceTimersByTime(300001);

      expect(fallbackHandler).toHaveBeenCalled();
      const [, fallback] = fallbackHandler.mock.calls[0];
      expect(fallback).toBe('retry');
    });

    it('warns about unimplemented notification channels', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      handler.dispose();
      handler = new EscalationHandler({
        config: { notificationChannels: ['discord', 'slack'] },
      });
      handler.attach(mockLifecycle);

      mockLifecycle.emit('escalate', 'Error', {});

      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  describe('Cleanup', () => {
    it('dispose clears all state', () => {
      mockLifecycle.emit('escalate', 'Error', {});

      handler.dispose();

      expect(handler.getLifecycle()).toBeNull();
      expect(handler.getAllEscalations()).toHaveLength(0);
    });

    it('dispose cancels all timeout timers', () => {
      mockLifecycle.emit('escalate', 'Error 1', {});
      mockLifecycle.emit('escalate', 'Error 2', {});

      handler.dispose();

      const timeoutHandler = vi.fn();
      handler.on('escalation:timeout', timeoutHandler);

      vi.advanceTimersByTime(200);

      expect(timeoutHandler).not.toHaveBeenCalled();
    });

    it('dispose removes all event listeners', () => {
      const handler1 = vi.fn();
      handler.on('escalation:notified', handler1);

      handler.dispose();

      expect(handler.listenerCount('escalation:notified')).toBe(0);
    });
  });

  // ==========================================================================
  // Multiple Escalations
  // ==========================================================================

  describe('Multiple Escalations', () => {
    it('handles multiple concurrent escalations', () => {
      mockLifecycle.emit('escalate', 'Error 1', { id: 1 });
      mockLifecycle.emit('escalate', 'Error 2', { id: 2 });
      mockLifecycle.emit('escalate', 'Error 3', { id: 3 });

      expect(handler.getAllEscalations()).toHaveLength(3);
      expect(handler.hasActiveEscalation()).toBe(true);
    });

    it('acknowledges individual escalations independently', async () => {
      mockLifecycle.emit('escalate', 'Error 1', {});
      mockLifecycle.emit('escalate', 'Error 2', {});

      const [esc1, esc2] = handler.getAllEscalations();

      await handler.acknowledge(esc1.id);

      expect(handler.getEscalation(esc1.id)?.state).toBe('acknowledged');
      expect(handler.getEscalation(esc2.id)?.state).toBe('pending');
    });

    it('times out escalations independently', async () => {
      // Create handler with longer timeout
      handler.dispose();
      handler = new EscalationHandler({
        config: { ...defaultConfig, timeoutMs: 200 },
      });
      handler.attach(mockLifecycle);

      mockLifecycle.emit('escalate', 'Error 1', {});

      // Wait 100ms then add second
      vi.advanceTimersByTime(100);
      mockLifecycle.emit('escalate', 'Error 2', {});

      // Wait another 100ms - first should timeout, second should not
      vi.advanceTimersByTime(100);

      const escalations = handler.getAllEscalations();
      expect(escalations[0].state).toBe('timeout');
      expect(escalations[1].state).toBe('pending');

      // Wait final 100ms - second should timeout
      vi.advanceTimersByTime(100);
      expect(handler.getEscalation(escalations[1].id)?.state).toBe('timeout');
    });
  });
});
