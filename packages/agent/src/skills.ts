/**
 * Skills Registry
 *
 * Manages skill discovery and tool registration for extending agent capabilities.
 * Provides capability-based lookup and structured error handling.
 *
 * @see @agent-skills
 */

import { EventEmitter } from 'node:events';
import { createLogger, KyneticError } from '@kynetic-bot/core';
import type {
  Skill,
  SkillContext,
  SkillsRegistryOptions,
  SkillsRegistryEvents,
  SkillResult,
  SkillState,
} from './skills-types.js';

const log = createLogger('skills-registry');

// ============================================================================
// Errors
// ============================================================================

/**
 * Base error for skill operations
 */
export class SkillError extends KyneticError {
  readonly skillId?: string;

  constructor(
    message: string,
    code: string,
    skillId?: string,
    context?: Record<string, unknown>,
  ) {
    super(message, `SKILL_${code}`, { ...context, skillId });
    this.skillId = skillId;
  }
}

/**
 * Error thrown when skill validation fails
 *
 * AC: @trait-validated ac-1 - Returns structured error
 * AC: @trait-validated ac-2 - Identifies missing fields
 */
export class SkillValidationError extends SkillError {
  readonly missingFields?: string[];

  constructor(
    message: string,
    skillId?: string,
    missingFields?: string[],
    context?: Record<string, unknown>,
  ) {
    super(message, 'VALIDATION_ERROR', skillId, { ...context, missingFields });
    this.missingFields = missingFields;
  }
}

/**
 * Error thrown when skill execution fails
 *
 * AC: @agent-skills ac-3 - Structured error for execution failures
 */
export class SkillExecutionError extends SkillError {
  readonly originalError?: Error;

  constructor(
    message: string,
    skillId: string,
    originalError?: Error,
    context?: Record<string, unknown>,
  ) {
    super(message, 'EXECUTION_ERROR', skillId, {
      ...context,
      originalError: originalError?.message,
    });
    this.originalError = originalError;
  }
}

/**
 * Error thrown when skill is not found
 */
export class SkillNotFoundError extends SkillError {
  constructor(skillIdOrCapability: string, byCapability = false) {
    super(
      byCapability
        ? `No skill found with capability: ${skillIdOrCapability}`
        : `Skill not found: ${skillIdOrCapability}`,
      'NOT_FOUND',
      byCapability ? undefined : skillIdOrCapability,
      { byCapability },
    );
  }
}

// ============================================================================
// Required Skill Interface Methods
// ============================================================================

const REQUIRED_SKILL_METHODS = [
  'id',
  'name',
  'description',
  'version',
  'capabilities',
  'isReady',
  'getState',
  'initialize',
  'execute',
  'dispose',
] as const;

// ============================================================================
// SkillsRegistry Implementation
// ============================================================================

/**
 * SkillsRegistry manages skill discovery and execution.
 *
 * Storage layout:
 * - Skills are registered in-memory by ID
 * - Capability index maps capabilities to skill IDs
 *
 * @example
 * ```typescript
 * const registry = new SkillsRegistry({ baseDir: '.kbot' });
 *
 * // Register a skill
 * registry.register(mySkill);
 *
 * // Get skill by capability
 * const skill = registry.getSkillByCapability('task-management');
 * if (skill) {
 *   const result = await registry.executeSkill(skill.id, { action: 'list' });
 * }
 * ```
 */
export class SkillsRegistry extends EventEmitter {
  private readonly skills = new Map<string, Skill>();
  private readonly capabilityIndex = new Map<string, Set<string>>();
  private readonly baseDir: string;
  private readonly autoInitialize: boolean;

  constructor(options: SkillsRegistryOptions = {}) {
    super();
    this.baseDir = options.baseDir ?? process.cwd();
    this.autoInitialize = options.autoInitialize ?? false;
  }

  // ==========================================================================
  // Emit Helper
  // ==========================================================================

  private emitEvent<K extends keyof SkillsRegistryEvents>(
    event: K,
    data: SkillsRegistryEvents[K],
  ): void {
    this.emit(event, data);
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  /**
   * Validate that an object implements the Skill interface
   *
   * AC: @trait-validated ac-1 - Returns structured error
   * AC: @trait-validated ac-2 - Identifies missing fields
   */
  private validateSkillInterface(skill: unknown): skill is Skill {
    if (!skill || typeof skill !== 'object') {
      throw new SkillValidationError('Skill must be an object', undefined, ['skill']);
    }

    const missingFields: string[] = [];

    for (const method of REQUIRED_SKILL_METHODS) {
      if (!(method in skill)) {
        missingFields.push(method);
      }
    }

    if (missingFields.length > 0) {
      throw new SkillValidationError(
        `Skill is missing required fields: ${missingFields.join(', ')}`,
        (skill as { id?: string }).id,
        missingFields,
      );
    }

    const s = skill as Skill;

    // Validate field types
    if (typeof s.id !== 'string' || s.id.trim().length === 0) {
      throw new SkillValidationError('Skill id must be a non-empty string', s.id, ['id']);
    }
    if (typeof s.name !== 'string' || s.name.trim().length === 0) {
      throw new SkillValidationError('Skill name must be a non-empty string', s.id, ['name']);
    }
    if (typeof s.description !== 'string') {
      throw new SkillValidationError('Skill description must be a string', s.id, ['description']);
    }
    if (typeof s.version !== 'string') {
      throw new SkillValidationError('Skill version must be a string', s.id, ['version']);
    }
    if (!Array.isArray(s.capabilities)) {
      throw new SkillValidationError('Skill capabilities must be an array', s.id, ['capabilities']);
    }
    if (typeof s.isReady !== 'function') {
      throw new SkillValidationError('Skill isReady must be a function', s.id, ['isReady']);
    }
    if (typeof s.getState !== 'function') {
      throw new SkillValidationError('Skill getState must be a function', s.id, ['getState']);
    }
    if (typeof s.initialize !== 'function') {
      throw new SkillValidationError('Skill initialize must be a function', s.id, ['initialize']);
    }
    if (typeof s.execute !== 'function') {
      throw new SkillValidationError('Skill execute must be a function', s.id, ['execute']);
    }
    if (typeof s.dispose !== 'function') {
      throw new SkillValidationError('Skill dispose must be a function', s.id, ['dispose']);
    }

    return true;
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  /**
   * Register a skill with the registry.
   *
   * AC: @agent-skills ac-1 - Discovers and registers skill with capabilities
   *
   * @param skill Skill to register
   * @throws SkillValidationError if skill doesn't implement required interface
   * @throws SkillError if skill with same ID already registered
   */
  async register(skill: Skill): Promise<void> {
    // Validate interface
    this.validateSkillInterface(skill);

    // Check for duplicates
    if (this.skills.has(skill.id)) {
      throw new SkillError(
        `Skill with ID already registered: ${skill.id}`,
        'ALREADY_REGISTERED',
        skill.id,
      );
    }

    // Store skill
    this.skills.set(skill.id, skill);

    // Index capabilities
    for (const capability of skill.capabilities) {
      let skillIds = this.capabilityIndex.get(capability);
      if (!skillIds) {
        skillIds = new Set();
        this.capabilityIndex.set(capability, skillIds);
      }
      skillIds.add(skill.id);
    }

    log.info('Skill registered', {
      id: skill.id,
      name: skill.name,
      capabilities: skill.capabilities,
    });

    this.emitEvent('skill:registered', {
      skillId: skill.id,
      name: skill.name,
      capabilities: skill.capabilities,
    });

    // Auto-initialize if configured
    if (this.autoInitialize) {
      try {
        await skill.initialize();
      } catch (err) {
        log.warn('Failed to auto-initialize skill', {
          id: skill.id,
          error: (err as Error).message,
        });
        this.emitEvent('error', {
          error: err as Error,
          operation: 'auto-initialize',
          skillId: skill.id,
        });
      }
    }
  }

  /**
   * Unregister a skill from the registry.
   *
   * @param skillId Skill ID to unregister
   * @param dispose Whether to call dispose on the skill (default: true)
   * @returns true if skill was removed, false if not found
   */
  async unregister(skillId: string, dispose = true): Promise<boolean> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return false;
    }

    // Remove from capability index
    for (const capability of skill.capabilities) {
      const skillIds = this.capabilityIndex.get(capability);
      if (skillIds) {
        skillIds.delete(skillId);
        if (skillIds.size === 0) {
          this.capabilityIndex.delete(capability);
        }
      }
    }

    // Dispose skill
    if (dispose) {
      try {
        await skill.dispose();
      } catch (err) {
        log.warn('Error disposing skill', {
          id: skillId,
          error: (err as Error).message,
        });
      }
    }

    // Remove from registry
    this.skills.delete(skillId);

    log.info('Skill unregistered', { id: skillId });
    this.emitEvent('skill:unregistered', { skillId });

    return true;
  }

  // ==========================================================================
  // Lookup
  // ==========================================================================

  /**
   * Get a skill by ID.
   *
   * @param skillId Skill ID to look up
   * @returns Skill or undefined if not found
   */
  getSkill(skillId: string): Skill | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Get skill by capability.
   *
   * AC: @agent-skills ac-2 - Returns appropriate tool for the capability
   *
   * @param capability Capability to look up
   * @returns First skill with the capability, or undefined if none found
   */
  getSkillByCapability(capability: string): Skill | undefined {
    const skillIds = this.capabilityIndex.get(capability);
    if (!skillIds || skillIds.size === 0) {
      return undefined;
    }

    // Return first skill with this capability
    const firstId = skillIds.values().next().value;
    return firstId ? this.skills.get(firstId) : undefined;
  }

  /**
   * Get all skills that provide a capability.
   *
   * @param capability Capability to look up
   * @returns Array of skills with the capability
   */
  getSkillsByCapability(capability: string): Skill[] {
    const skillIds = this.capabilityIndex.get(capability);
    if (!skillIds || skillIds.size === 0) {
      return [];
    }

    const skills: Skill[] = [];
    for (const id of skillIds) {
      const skill = this.skills.get(id);
      if (skill) {
        skills.push(skill);
      }
    }
    return skills;
  }

  /**
   * List all registered skills.
   *
   * @returns Array of all registered skills
   */
  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * List all available capabilities.
   *
   * @returns Array of capability names
   */
  listCapabilities(): string[] {
    return Array.from(this.capabilityIndex.keys());
  }

  /**
   * Check if a skill is registered.
   *
   * @param skillId Skill ID to check
   * @returns true if skill is registered
   */
  hasSkill(skillId: string): boolean {
    return this.skills.has(skillId);
  }

  /**
   * Check if a capability is available.
   *
   * @param capability Capability to check
   * @returns true if at least one skill provides this capability
   */
  hasCapability(capability: string): boolean {
    const skillIds = this.capabilityIndex.get(capability);
    return skillIds !== undefined && skillIds.size > 0;
  }

  // ==========================================================================
  // Execution
  // ==========================================================================

  /**
   * Execute a skill by ID.
   *
   * AC: @agent-skills ac-3 - Logs failure and returns structured error
   *
   * @param skillId Skill ID to execute
   * @param params Parameters to pass to skill
   * @returns Skill result
   */
  async executeSkill(skillId: string, params: unknown): Promise<SkillResult<unknown>> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      const error = new SkillNotFoundError(skillId);
      this.emitEvent('error', { error, operation: 'execute', skillId });
      return { ok: false, error };
    }

    return this.executeSkillInternal(skill, params);
  }

  /**
   * Execute a skill by capability.
   *
   * @param capability Capability to use
   * @param params Parameters to pass to skill
   * @returns Skill result
   */
  async executeByCapability(capability: string, params: unknown): Promise<SkillResult<unknown>> {
    const skill = this.getSkillByCapability(capability);
    if (!skill) {
      const error = new SkillNotFoundError(capability, true);
      this.emitEvent('error', { error, operation: 'executeByCapability' });
      return { ok: false, error };
    }

    return this.executeSkillInternal(skill, params);
  }

  /**
   * Internal skill execution with error handling and observability.
   */
  private async executeSkillInternal(skill: Skill, params: unknown): Promise<SkillResult<unknown>> {
    const startTime = Date.now();

    this.emitEvent('skill:execute:start', { skillId: skill.id, params });

    // Ensure skill is initialized
    if (!skill.isReady()) {
      try {
        await skill.initialize();
      } catch (err) {
        const error = new SkillExecutionError(
          `Failed to initialize skill: ${(err as Error).message}`,
          skill.id,
          err as Error,
        );
        const durationMs = Date.now() - startTime;

        log.error('Skill initialization failed', {
          skillId: skill.id,
          error: error.message,
          durationMs,
        });

        this.emitEvent('skill:execute:error', { skillId: skill.id, error, durationMs });
        this.emitEvent('error', { error, operation: 'execute-initialize', skillId: skill.id });

        return { ok: false, error };
      }
    }

    // Execute skill
    try {
      const result = await skill.execute(params);
      const durationMs = Date.now() - startTime;

      log.debug('Skill executed successfully', {
        skillId: skill.id,
        durationMs,
      });

      this.emitEvent('skill:execute:complete', { skillId: skill.id, result, durationMs });

      return { ok: true, value: result };
    } catch (err) {
      const error = new SkillExecutionError(
        `Skill execution failed: ${(err as Error).message}`,
        skill.id,
        err as Error,
      );
      const durationMs = Date.now() - startTime;

      // AC-3: Logs failure
      log.error('Skill execution failed', {
        skillId: skill.id,
        error: error.message,
        durationMs,
      });

      this.emitEvent('skill:execute:error', { skillId: skill.id, error, durationMs });
      this.emitEvent('error', { error, operation: 'execute', skillId: skill.id });

      // AC-3: Returns structured error to agent
      return { ok: false, error };
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Initialize all registered skills.
   *
   * @returns Object with counts of initialized and failed skills
   */
  async initializeAll(): Promise<{ initialized: number; failed: number }> {
    let initialized = 0;
    let failed = 0;

    for (const skill of this.skills.values()) {
      if (skill.isReady()) {
        initialized++;
        continue;
      }

      try {
        await skill.initialize();
        initialized++;
      } catch (err) {
        failed++;
        log.warn('Failed to initialize skill', {
          id: skill.id,
          error: (err as Error).message,
        });
        this.emitEvent('error', {
          error: err as Error,
          operation: 'initializeAll',
          skillId: skill.id,
        });
      }
    }

    return { initialized, failed };
  }

  /**
   * Dispose all registered skills and clear the registry.
   */
  async disposeAll(): Promise<void> {
    const skills = Array.from(this.skills.values());

    for (const skill of skills) {
      await this.unregister(skill.id, true);
    }

    this.capabilityIndex.clear();
  }

  /**
   * Get the number of registered skills.
   */
  get size(): number {
    return this.skills.size;
  }

  /**
   * Get the context for skill execution.
   */
  getContext(): SkillContext {
    return {
      baseDir: this.baseDir,
    };
  }
}
