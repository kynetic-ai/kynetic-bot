/**
 * Agent Lifecycle Types
 *
 * Type definitions for agent process lifecycle management.
 */

/**
 * Configuration options for AgentLifecycle
 */
export interface AgentLifecycleOptions {
  /** Command to spawn the agent (e.g., 'claude-code') */
  command: string;

  /** Arguments to pass to the command */
  args?: string[];

  /** Working directory for the agent process */
  cwd?: string;

  /** Environment variables to pass to the agent (merged with KYNETIC_* vars) */
  env?: Record<string, string>;

  /** Interval between health checks in milliseconds (default: 30000) */
  healthCheckInterval?: number;

  /** Number of consecutive failures before marking unhealthy (default: 3) */
  failureThreshold?: number;

  /** Timeout for graceful shutdown in milliseconds (default: 10000) */
  shutdownTimeout?: number;

  /** Maximum concurrent spawn operations (default: 1) */
  maxConcurrentSpawns?: number;

  /** Backoff configuration for spawn retries */
  backoff?: {
    /** Initial delay in milliseconds (default: 1000) */
    initial?: number;
    /** Maximum delay in milliseconds (default: 60000) */
    max?: number;
    /** Multiplier for exponential backoff (default: 2) */
    multiplier?: number;
  };
}

/**
 * Agent lifecycle states
 *
 * State machine:
 * idle -> spawning -> healthy <-> unhealthy -> terminating -> idle
 *            |           |                          ^
 *         failed         +-> stopping --------------+
 *            |
 *            v (backoff then retry)
 */
export type AgentLifecycleState =
  | 'idle' // No process, ready to spawn
  | 'spawning' // Process starting, awaiting ACP init
  | 'healthy' // Running, health checks passing
  | 'unhealthy' // Running, health checks failing
  | 'stopping' // Graceful shutdown (SIGTERM, waiting)
  | 'terminating' // Force shutdown (SIGKILL)
  | 'failed'; // Spawn failed, waiting for backoff

/**
 * Checkpoint data for state persistence
 */
export interface AgentCheckpoint {
  /** Timestamp when checkpoint was created */
  timestamp: number;

  /** Current lifecycle state */
  state: AgentLifecycleState;

  /** Session ID if agent has an active session */
  sessionId?: string;

  /** Number of consecutive health check failures */
  consecutiveFailures: number;

  /** Current backoff delay in milliseconds */
  currentBackoffMs: number;
}

/**
 * Events emitted by AgentLifecycle
 */
export interface AgentLifecycleEvents {
  /** State transition occurred */
  'state:change': (from: AgentLifecycleState, to: AgentLifecycleState) => void;

  /** Agent process was spawned */
  'agent:spawned': (pid: number) => void;

  /** Agent process exited */
  'agent:exited': (code: number | null, signal: NodeJS.Signals | null) => void;

  /** Health check was performed */
  'health:check': (passed: boolean, consecutiveFailures: number) => void;

  /** Health status changed */
  'health:status': (healthy: boolean, recovered: boolean) => void;

  /** Error occurred */
  error: (error: Error, context: Record<string, unknown>) => void;

  /** Spawn request was queued due to rate limiting */
  'spawn:queued': (queueLength: number) => void;

  /** Spawn request was dequeued and processing */
  'spawn:dequeued': (queueLength: number) => void;

  /** Checkpoint was saved */
  'checkpoint:saved': (checkpoint: AgentCheckpoint) => void;

  /** Shutdown completed */
  'shutdown:complete': () => void;

  /** Unrecoverable state reached, escalation needed */
  escalate: (reason: string, context: Record<string, unknown>) => void;
}

/**
 * Queued spawn request
 */
export interface QueuedSpawnRequest {
  /** Environment variables for this spawn */
  env?: Record<string, string>;

  /** Resolve when spawn completes */
  resolve: () => void;

  /** Reject if spawn fails */
  reject: (error: Error) => void;
}
