/**
 * Skills System Types
 *
 * Type definitions for skill discovery and tool registration.
 *
 * @see @agent-skills
 */

import type { KyneticError } from '@kynetic-bot/core';

/**
 * Skill state values
 */
export type SkillState = 'uninitialized' | 'ready' | 'executing' | 'error' | 'disposed';

/**
 * Base skill interface
 *
 * Skills extend agent capabilities with specialized functionality.
 * Following AgentLifecycle patterns for state management and events.
 */
export interface Skill {
  /** Unique skill identifier */
  readonly id: string;

  /** Human-readable skill name */
  readonly name: string;

  /** Description of skill functionality */
  readonly description: string;

  /** Skill version */
  readonly version: string;

  /** Capabilities this skill provides (e.g., 'task-management', 'memory-access') */
  readonly capabilities: string[];

  /** Check if skill is ready for execution */
  isReady(): boolean;

  /** Get current skill state */
  getState(): SkillState;

  /** Initialize the skill (idempotent) */
  initialize(): Promise<void>;

  /**
   * Execute the skill with given parameters
   *
   * @param params Parameters for execution
   * @returns Execution result
   * @throws SkillExecutionError if execution fails
   */
  execute(params: unknown): Promise<unknown>;

  /** Cleanup resources (idempotent) */
  dispose(): Promise<void>;
}

/**
 * Context provided to skills during execution
 */
export interface SkillContext {
  /** Session key for routing */
  sessionKey?: string;

  /** Agent identifier */
  agentId?: string;

  /** Base directory for file operations */
  baseDir: string;

  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Options for creating a SkillsRegistry
 */
export interface SkillsRegistryOptions {
  /** Base directory for skill operations (default: cwd) */
  baseDir?: string;

  /** Whether to auto-initialize skills on registration (default: false) */
  autoInitialize?: boolean;
}

/**
 * Events emitted by SkillsRegistry
 *
 * AC: @agent-skills ac-1 - Discovery and registration events
 * AC: @agent-skills ac-3 - Error events
 */
export interface SkillsRegistryEvents {
  /** Skill was registered */
  'skill:registered': { skillId: string; name: string; capabilities: string[] };

  /** Skill was unregistered */
  'skill:unregistered': { skillId: string };

  /** Skill execution started */
  'skill:execute:start': { skillId: string; params: unknown };

  /** Skill execution completed */
  'skill:execute:complete': { skillId: string; result: unknown; durationMs: number };

  /** Skill execution failed */
  'skill:execute:error': { skillId: string; error: Error; durationMs: number };

  /** Error occurred */
  error: { error: Error; operation: string; skillId?: string };
}

/**
 * Result type for skill operations
 */
export type SkillResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: KyneticError };
