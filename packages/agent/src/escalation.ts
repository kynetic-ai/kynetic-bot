/**
 * Escalation Handler
 *
 * Manages human escalation paths for agent failures with configurable thresholds.
 * Provides notification, acknowledgment tracking, and fallback behaviors.
 *
 * @see @agent-escalation
 */

import { EventEmitter } from 'node:events';
import { createLogger, KyneticError } from '@kynetic-bot/core';
import type { AgentLifecycle, AgentCheckpoint } from './index.js';

const log = createLogger('escalation-handler');

// ============================================================================
// Errors
// ============================================================================

/**
 * Base error for escalation operations
 */
export class EscalationError extends KyneticError {
  readonly escalationId?: string;

  constructor(
    message: string,
    code: string,
    escalationId?: string,
    context?: Record<string, unknown>,
  ) {
    super(message, `ESCALATION_${code}`, { ...context, escalationId });
    this.escalationId = escalationId;
  }
}

/**
 * Error thrown when escalation not found
 */
export class EscalationNotFoundError extends EscalationError {
  constructor(escalationId: string) {
    super(`Escalation not found: ${escalationId}`, 'NOT_FOUND', escalationId);
  }
}

/**
 * Error thrown when escalation already acknowledged
 */
export class EscalationAlreadyAcknowledgedError extends EscalationError {
  constructor(escalationId: string) {
    super(
      `Escalation already acknowledged: ${escalationId}`,
      'ALREADY_ACKNOWLEDGED',
      escalationId,
    );
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Escalation state
 */
export type EscalationState = 'idle' | 'pending' | 'acknowledged' | 'timeout';

/**
 * Fallback behavior when no human response
 */
export type EscalationFallback = 'retry' | 'pause' | 'fail';

/**
 * Configuration for EscalationHandler
 */
export interface EscalationConfig {
  /** Channels to notify on escalation (e.g., ['console']) */
  notificationChannels: string[];

  /** Timeout for human response in milliseconds (default: 300000 = 5 min) */
  timeoutMs?: number;

  /** Fallback behavior when timeout reached (default: 'retry') */
  fallback?: EscalationFallback;

  /** Human contacts for notification (future use) */
  contacts?: Record<string, string>;
}

/**
 * Escalation record tracking an active escalation
 */
export interface EscalationRecord {
  /** Unique ID for this escalation (ULID-style) */
  id: string;

  /** Session key if available */
  sessionKey?: string;

  /** Reason for escalation */
  reason: string;

  /** Additional context from the agent */
  context: Record<string, unknown>;

  /** Current escalation state */
  state: EscalationState;

  /** Timestamp when escalation was triggered */
  triggeredAt: number;

  /** Timestamp when escalation was acknowledged (if applicable) */
  acknowledgedAt?: number;

  /** Human ID who acknowledged (if applicable) */
  acknowledgedBy?: string;

  /** Agent checkpoint at time of escalation */
  checkpoint?: AgentCheckpoint;
}

/**
 * Events emitted by EscalationHandler
 *
 * AC: @trait-observable - Emits structured events
 */
export interface EscalationHandlerEvents {
  /** Escalation triggered and notifications sent */
  'escalation:notified': (record: EscalationRecord) => void;

  /** Escalation acknowledged by human */
  'escalation:acknowledged': (
    record: EscalationRecord,
    humanId?: string,
  ) => void;

  /** Escalation timed out, executing fallback */
  'escalation:timeout': (record: EscalationRecord) => void;

  /** Fallback behavior executed */
  'escalation:fallback': (
    record: EscalationRecord,
    fallback: EscalationFallback,
  ) => void;

  /** State changed */
  'state:change': (
    escalationId: string,
    from: EscalationState,
    to: EscalationState,
  ) => void;

  /** Error occurred during escalation handling */
  error: (error: Error, context: Record<string, unknown>) => void;
}

/**
 * Options for EscalationHandler constructor
 */
export interface EscalationHandlerOptions {
  /** Configuration for escalation handling */
  config: EscalationConfig;
}

// ============================================================================
// EscalationHandler
// ============================================================================

/**
 * Manages human escalation paths for agent failures.
 *
 * Subscribes to AgentLifecycle 'escalate' events and:
 * 1. Notifies configured channels with context (AC-1)
 * 2. Tracks acknowledgment for human handoff (AC-2)
 * 3. Executes fallback behavior on timeout (AC-3)
 *
 * @example
 * ```typescript
 * const handler = new EscalationHandler({
 *   config: {
 *     notificationChannels: ['console'],
 *     timeoutMs: 300000, // 5 minutes
 *     fallback: 'retry',
 *   },
 * });
 *
 * // Attach to lifecycle
 * handler.attach(lifecycle);
 *
 * // Handle escalation acknowledgment
 * await handler.acknowledge(escalationId, 'human@example.com');
 * ```
 */
export class EscalationHandler extends EventEmitter {
  private config: Required<EscalationConfig>;
  private escalations = new Map<string, EscalationRecord>();
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private attachedLifecycle: AgentLifecycle | null = null;
  private boundEscalateHandler: (
    reason: string,
    context: Record<string, unknown>,
  ) => void;

  constructor(options: EscalationHandlerOptions) {
    super();

    this.config = {
      notificationChannels: options.config.notificationChannels,
      timeoutMs: options.config.timeoutMs ?? 300000, // 5 minutes
      fallback: options.config.fallback ?? 'retry',
      contacts: options.config.contacts ?? {},
    };

    // Bind handler for attach/detach
    this.boundEscalateHandler = this.handleEscalation.bind(this);
  }

  // ============================================================================
  // Lifecycle Integration
  // ============================================================================

  /**
   * Attach to an AgentLifecycle instance to listen for escalate events
   */
  attach(lifecycle: AgentLifecycle): void {
    if (this.attachedLifecycle) {
      this.detach();
    }

    this.attachedLifecycle = lifecycle;
    lifecycle.on('escalate', this.boundEscalateHandler);

    log.debug('Attached to AgentLifecycle');
  }

  /**
   * Detach from the current AgentLifecycle
   */
  detach(): void {
    if (this.attachedLifecycle) {
      this.attachedLifecycle.off('escalate', this.boundEscalateHandler);
      this.attachedLifecycle = null;

      log.debug('Detached from AgentLifecycle');
    }
  }

  /**
   * Get the attached lifecycle (if any)
   */
  getLifecycle(): AgentLifecycle | null {
    return this.attachedLifecycle;
  }

  // ============================================================================
  // Escalation Handling
  // ============================================================================

  /**
   * Handle escalation event from AgentLifecycle
   *
   * AC-1: Notifies configured human contacts with context
   */
  private handleEscalation(
    reason: string,
    context: Record<string, unknown>,
  ): void {
    const escalationId = this.generateId();

    // Get checkpoint from lifecycle if available
    const checkpoint = this.attachedLifecycle?.getCheckpoint();

    const record: EscalationRecord = {
      id: escalationId,
      reason,
      context,
      state: 'pending',
      triggeredAt: Date.now(),
      checkpoint,
    };

    this.escalations.set(escalationId, record);

    log.warn('Escalation triggered', {
      escalationId,
      reason,
      context,
    });

    // Notify all configured channels (MVP: console only)
    this.notifyChannels(record);

    // Emit notified event
    this.emit('escalation:notified', record);

    // Start timeout timer (AC-3)
    this.startTimeoutTimer(escalationId);
  }

  /**
   * Notify configured channels about escalation
   *
   * MVP: Console only. Future: Discord, Slack via ChannelRegistry
   */
  private notifyChannels(record: EscalationRecord): void {
    for (const channel of this.config.notificationChannels) {
      if (channel === 'console') {
        // Console notification (always available)
        log.error('🚨 ESCALATION REQUIRED', {
          id: record.id,
          reason: record.reason,
          context: record.context,
          checkpoint: record.checkpoint,
          timeout: `${this.config.timeoutMs / 1000}s`,
          fallback: this.config.fallback,
        });
      } else {
        // Future: Use ChannelRegistry to send to Discord/Slack
        log.warn('Notification channel not implemented', { channel });
      }
    }
  }

  /**
   * Acknowledge an escalation (human takes over)
   *
   * AC-2: Pauses agent and provides conversation handoff
   *
   * @param escalationId - ID of escalation to acknowledge
   * @param humanId - Optional identifier of human acknowledging
   */
  async acknowledge(escalationId: string, humanId?: string): Promise<void> {
    const record = this.escalations.get(escalationId);

    if (!record) {
      throw new EscalationNotFoundError(escalationId);
    }

    if (record.state === 'acknowledged') {
      throw new EscalationAlreadyAcknowledgedError(escalationId);
    }

    if (record.state === 'timeout') {
      // Allow acknowledging after timeout (human finally responded)
      log.info('Late acknowledgment after timeout', { escalationId, humanId });
    }

    // Cancel timeout if pending
    this.cancelTimeoutTimer(escalationId);

    const previousState = record.state;
    record.state = 'acknowledged';
    record.acknowledgedAt = Date.now();
    record.acknowledgedBy = humanId;

    log.info('Escalation acknowledged', {
      escalationId,
      humanId,
      previousState,
    });

    // Emit state change
    this.emit('state:change', escalationId, previousState, 'acknowledged');

    // Emit acknowledged event with handoff context
    this.emit('escalation:acknowledged', record, humanId);

    // AC-2: Agent pauses - caller should stop the lifecycle
    // The event listener can call lifecycle.stop() if needed
  }

  /**
   * Get handoff context for acknowledged escalation
   *
   * Returns context needed for human to take over the conversation.
   */
  getHandoffContext(
    escalationId: string,
  ): { record: EscalationRecord; checkpoint?: AgentCheckpoint } | null {
    const record = this.escalations.get(escalationId);

    if (!record || record.state !== 'acknowledged') {
      return null;
    }

    return {
      record,
      checkpoint: record.checkpoint,
    };
  }

  // ============================================================================
  // Timeout Handling
  // ============================================================================

  /**
   * Start timeout timer for escalation
   */
  private startTimeoutTimer(escalationId: string): void {
    const timer = setTimeout(() => {
      this.handleTimeout(escalationId);
    }, this.config.timeoutMs);

    // Don't keep process alive for escalation timers
    timer.unref();

    this.timeoutTimers.set(escalationId, timer);
  }

  /**
   * Cancel timeout timer for escalation
   */
  private cancelTimeoutTimer(escalationId: string): void {
    const timer = this.timeoutTimers.get(escalationId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(escalationId);
    }
  }

  /**
   * Handle escalation timeout
   *
   * AC-3: Follows configured fallback behavior
   */
  private handleTimeout(escalationId: string): void {
    const record = this.escalations.get(escalationId);

    if (!record || record.state !== 'pending') {
      // Already handled (acknowledged, etc.)
      return;
    }

    const previousState = record.state;
    record.state = 'timeout';

    log.warn('Escalation timeout reached', {
      escalationId,
      fallback: this.config.fallback,
      elapsedMs: Date.now() - record.triggeredAt,
    });

    // Emit state change
    this.emit('state:change', escalationId, previousState, 'timeout');

    // Emit timeout event
    this.emit('escalation:timeout', record);

    // Execute fallback
    this.executeFallback(record);
  }

  /**
   * Execute fallback behavior
   */
  private executeFallback(record: EscalationRecord): void {
    const fallback = this.config.fallback;

    log.info('Executing fallback behavior', {
      escalationId: record.id,
      fallback,
    });

    this.emit('escalation:fallback', record, fallback);

    switch (fallback) {
      case 'retry':
        // Signal to retry spawn - caller listens for fallback event
        // and can call lifecycle.spawn() again
        log.info('Fallback: retry spawn', { escalationId: record.id });
        break;

      case 'pause':
        // Signal to pause - agent stays stopped
        log.info('Fallback: pause agent', { escalationId: record.id });
        break;

      case 'fail':
        // Signal permanent failure
        log.error('Fallback: permanent failure', { escalationId: record.id });
        break;
    }
  }

  // ============================================================================
  // State & Query
  // ============================================================================

  /**
   * Get escalation record by ID
   */
  getEscalation(escalationId: string): EscalationRecord | undefined {
    return this.escalations.get(escalationId);
  }

  /**
   * Get all pending escalations
   */
  getPendingEscalations(): EscalationRecord[] {
    return Array.from(this.escalations.values()).filter(
      (r) => r.state === 'pending',
    );
  }

  /**
   * Get all escalations
   */
  getAllEscalations(): EscalationRecord[] {
    return Array.from(this.escalations.values());
  }

  /**
   * Check if there's an active (pending) escalation
   */
  hasActiveEscalation(): boolean {
    return this.getPendingEscalations().length > 0;
  }

  /**
   * Clear resolved escalations (acknowledged or timed out with fallback)
   */
  clearResolvedEscalations(): number {
    const resolved = Array.from(this.escalations.entries()).filter(
      ([, record]) => record.state === 'acknowledged' || record.state === 'timeout',
    );

    for (const [id] of resolved) {
      this.escalations.delete(id);
    }

    return resolved.length;
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Dispose of the handler, cleaning up all resources
   */
  dispose(): void {
    // Cancel all timeout timers
    for (const timer of this.timeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.timeoutTimers.clear();

    // Detach from lifecycle
    this.detach();

    // Clear escalations
    this.escalations.clear();

    // Remove all listeners
    this.removeAllListeners();

    log.debug('EscalationHandler disposed');
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Generate a unique escalation ID
   */
  private generateId(): string {
    // Simple ID generation - in production use ULID
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `esc_${timestamp}_${random}`;
  }
}
