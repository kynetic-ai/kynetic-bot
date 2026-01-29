/**
 * SkillsRegistry Tests
 *
 * Tests for skill discovery, registration, and execution.
 *
 * @see @agent-skills
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  SkillsRegistry,
  SkillError,
  SkillValidationError,
  SkillExecutionError,
  SkillNotFoundError,
} from '../src/skills.js';
import type { Skill, SkillState } from '../src/skills-types.js';

/**
 * Create a mock skill for testing
 */
function createMockSkill(overrides: Partial<Skill> = {}): Skill {
  let state: SkillState = 'uninitialized';

  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A skill for testing',
    version: '1.0.0',
    capabilities: ['testing', 'mocking'],
    isReady: () => state === 'ready',
    getState: () => state,
    initialize: vi.fn(async () => {
      state = 'ready';
    }),
    execute: vi.fn(async (params: unknown) => {
      state = 'executing';
      const result = { executed: true, params };
      state = 'ready';
      return result;
    }),
    dispose: vi.fn(async () => {
      state = 'disposed';
    }),
    ...overrides,
  };
}

describe('SkillsRegistry', () => {
  let registry: SkillsRegistry;

  beforeEach(() => {
    registry = new SkillsRegistry();
    // Suppress unhandled error events in tests
    registry.on('error', () => {});
  });

  describe('Registration', () => {
    // AC: @agent-skills ac-1 - Discovers and registers skill with capabilities
    it('registers a valid skill', async () => {
      const skill = createMockSkill();

      await registry.register(skill);

      expect(registry.hasSkill('test-skill')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('indexes skill capabilities', async () => {
      const skill = createMockSkill({
        capabilities: ['task-management', 'spec-access'],
      });

      await registry.register(skill);

      expect(registry.hasCapability('task-management')).toBe(true);
      expect(registry.hasCapability('spec-access')).toBe(true);
      expect(registry.hasCapability('unknown')).toBe(false);
    });

    it('emits skill:registered event', async () => {
      const skill = createMockSkill();
      const events: Array<{ skillId: string; name: string; capabilities: string[] }> = [];

      registry.on('skill:registered', (data) => events.push(data));

      await registry.register(skill);

      expect(events).toHaveLength(1);
      expect(events[0].skillId).toBe('test-skill');
      expect(events[0].name).toBe('Test Skill');
      expect(events[0].capabilities).toEqual(['testing', 'mocking']);
    });

    it('throws when registering duplicate skill ID', async () => {
      const skill1 = createMockSkill({ id: 'duplicate' });
      const skill2 = createMockSkill({ id: 'duplicate' });

      await registry.register(skill1);

      await expect(registry.register(skill2)).rejects.toThrow(SkillError);
      await expect(registry.register(skill2)).rejects.toThrow('already registered');
    });

    it('auto-initializes when configured', async () => {
      registry = new SkillsRegistry({ autoInitialize: true });
      const skill = createMockSkill();

      await registry.register(skill);

      expect(skill.initialize).toHaveBeenCalled();
    });

    it('does not auto-initialize by default', async () => {
      const skill = createMockSkill();

      await registry.register(skill);

      expect(skill.initialize).not.toHaveBeenCalled();
    });
  });

  describe('Validation (@trait-validated)', () => {
    // AC: @trait-validated ac-1 - Returns structured error
    it('throws SkillValidationError for non-object', async () => {
      await expect(registry.register(null as unknown as Skill)).rejects.toThrow(
        SkillValidationError,
      );
      await expect(registry.register('not-a-skill' as unknown as Skill)).rejects.toThrow(
        SkillValidationError,
      );
    });

    // AC: @trait-validated ac-2 - Identifies missing fields
    it('identifies missing required fields', async () => {
      const invalidSkill = { id: 'incomplete' } as unknown as Skill;

      try {
        await registry.register(invalidSkill);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SkillValidationError);
        const validationErr = err as SkillValidationError;
        expect(validationErr.missingFields).toBeDefined();
        expect(validationErr.missingFields?.length).toBeGreaterThan(0);
      }
    });

    it('throws for empty skill id', async () => {
      const skill = createMockSkill({ id: '' });

      await expect(registry.register(skill)).rejects.toThrow(SkillValidationError);
      await expect(registry.register(skill)).rejects.toThrow('non-empty string');
    });

    it('throws for empty skill name', async () => {
      const skill = createMockSkill({ name: '' });

      await expect(registry.register(skill)).rejects.toThrow(SkillValidationError);
      await expect(registry.register(skill)).rejects.toThrow('name');
    });

    it('throws for non-array capabilities', async () => {
      const skill = createMockSkill({ capabilities: 'not-an-array' as unknown as string[] });

      await expect(registry.register(skill)).rejects.toThrow(SkillValidationError);
      await expect(registry.register(skill)).rejects.toThrow('capabilities must be an array');
    });

    it('throws for non-function methods', async () => {
      const skill = createMockSkill({ execute: 'not-a-function' as unknown as Skill['execute'] });

      await expect(registry.register(skill)).rejects.toThrow(SkillValidationError);
      await expect(registry.register(skill)).rejects.toThrow('execute must be a function');
    });

    // AC: @trait-validated ac-3 - Type mismatch includes expected type in error
    it('includes expected and actual type in validation error context', async () => {
      const skill = createMockSkill({ description: 123 as unknown as string });

      try {
        await registry.register(skill);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SkillValidationError);
        const validationErr = err as SkillValidationError;
        expect(validationErr.context).toHaveProperty('expectedType', 'string');
        expect(validationErr.context).toHaveProperty('actualType', 'number');
      }
    });
  });

  describe('Unregistration', () => {
    it('unregisters a skill', async () => {
      const skill = createMockSkill();
      await registry.register(skill);

      const result = await registry.unregister('test-skill');

      expect(result).toBe(true);
      expect(registry.hasSkill('test-skill')).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('removes skill from capability index', async () => {
      const skill = createMockSkill({ capabilities: ['unique-cap'] });
      await registry.register(skill);
      expect(registry.hasCapability('unique-cap')).toBe(true);

      await registry.unregister('test-skill');

      expect(registry.hasCapability('unique-cap')).toBe(false);
    });

    it('calls dispose on skill by default', async () => {
      const skill = createMockSkill();
      await registry.register(skill);

      await registry.unregister('test-skill');

      expect(skill.dispose).toHaveBeenCalled();
    });

    it('skips dispose when specified', async () => {
      const skill = createMockSkill();
      await registry.register(skill);

      await registry.unregister('test-skill', false);

      expect(skill.dispose).not.toHaveBeenCalled();
    });

    it('returns false for unknown skill', async () => {
      const result = await registry.unregister('unknown');
      expect(result).toBe(false);
    });

    it('emits skill:unregistered event', async () => {
      const skill = createMockSkill();
      await registry.register(skill);

      const events: Array<{ skillId: string }> = [];
      registry.on('skill:unregistered', (data) => events.push(data));

      await registry.unregister('test-skill');

      expect(events).toHaveLength(1);
      expect(events[0].skillId).toBe('test-skill');
    });
  });

  describe('Lookup', () => {
    // AC: @agent-skills ac-2 - Returns appropriate tool for the capability
    it('gets skill by ID', async () => {
      const skill = createMockSkill();
      await registry.register(skill);

      const found = registry.getSkill('test-skill');

      expect(found).toBeDefined();
      expect(found?.id).toBe('test-skill');
    });

    it('returns undefined for unknown skill ID', () => {
      const found = registry.getSkill('unknown');
      expect(found).toBeUndefined();
    });

    // AC: @agent-skills ac-2 - Returns appropriate tool for the capability
    it('gets skill by capability', async () => {
      const skill = createMockSkill({ capabilities: ['memory-access'] });
      await registry.register(skill);

      const found = registry.getSkillByCapability('memory-access');

      expect(found).toBeDefined();
      expect(found?.id).toBe('test-skill');
    });

    it('returns undefined for unknown capability', () => {
      const found = registry.getSkillByCapability('unknown');
      expect(found).toBeUndefined();
    });

    it('gets all skills with a capability', async () => {
      const skill1 = createMockSkill({
        id: 'skill-1',
        capabilities: ['shared-cap', 'unique-1'],
      });
      const skill2 = createMockSkill({
        id: 'skill-2',
        capabilities: ['shared-cap', 'unique-2'],
      });

      await registry.register(skill1);
      await registry.register(skill2);

      const skills = registry.getSkillsByCapability('shared-cap');
      expect(skills).toHaveLength(2);
      expect(skills.map((s) => s.id)).toContain('skill-1');
      expect(skills.map((s) => s.id)).toContain('skill-2');
    });

    it('lists all registered skills', async () => {
      await registry.register(createMockSkill({ id: 'skill-1' }));
      await registry.register(createMockSkill({ id: 'skill-2' }));

      const skills = registry.listSkills();

      expect(skills).toHaveLength(2);
    });

    it('lists all capabilities', async () => {
      await registry.register(
        createMockSkill({
          id: 'skill-1',
          capabilities: ['cap-a', 'cap-b'],
        }),
      );
      await registry.register(
        createMockSkill({
          id: 'skill-2',
          capabilities: ['cap-b', 'cap-c'],
        }),
      );

      const capabilities = registry.listCapabilities();

      expect(capabilities).toHaveLength(3);
      expect(capabilities).toContain('cap-a');
      expect(capabilities).toContain('cap-b');
      expect(capabilities).toContain('cap-c');
    });
  });

  describe('Execution', () => {
    it('executes skill by ID', async () => {
      const skill = createMockSkill();
      await registry.register(skill);
      await skill.initialize();

      const result = await registry.executeSkill('test-skill', { action: 'test' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ executed: true, params: { action: 'test' } });
      }
    });

    it('auto-initializes skill before execution', async () => {
      const skill = createMockSkill();
      await registry.register(skill);

      await registry.executeSkill('test-skill', {});

      expect(skill.initialize).toHaveBeenCalled();
    });

    it('emits execute:start and execute:complete events', async () => {
      const skill = createMockSkill();
      await registry.register(skill);

      const startEvents: Array<{ skillId: string; params: unknown }> = [];
      const completeEvents: Array<{ skillId: string; result: unknown; durationMs: number }> = [];

      registry.on('skill:execute:start', (data) => startEvents.push(data));
      registry.on('skill:execute:complete', (data) => completeEvents.push(data));

      await registry.executeSkill('test-skill', { foo: 'bar' });

      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].skillId).toBe('test-skill');
      expect(startEvents[0].params).toEqual({ foo: 'bar' });

      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].skillId).toBe('test-skill');
      expect(completeEvents[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    // AC: @agent-skills ac-3 - Returns structured error
    it('returns SkillNotFoundError for unknown skill', async () => {
      const result = await registry.executeSkill('unknown', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillNotFoundError);
      }
    });

    // AC: @agent-skills ac-3 - Logs failure and returns structured error
    it('returns SkillExecutionError when skill throws', async () => {
      const skill = createMockSkill({
        execute: vi.fn(async () => {
          throw new Error('Execution failed');
        }),
      });
      await registry.register(skill);

      const result = await registry.executeSkill('test-skill', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillExecutionError);
        expect(result.error.message).toContain('Execution failed');
      }
    });

    it('emits execute:error event on failure', async () => {
      const skill = createMockSkill({
        execute: vi.fn(async () => {
          throw new Error('Test error');
        }),
      });
      await registry.register(skill);

      const errorEvents: Array<{ skillId: string; error: Error; durationMs: number }> = [];
      registry.on('skill:execute:error', (data) => errorEvents.push(data));

      await registry.executeSkill('test-skill', {});

      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].skillId).toBe('test-skill');
      expect(errorEvents[0].error.message).toContain('Test error');
    });

    it('executes skill by capability', async () => {
      const skill = createMockSkill({ capabilities: ['unique-capability'] });
      await registry.register(skill);

      const result = await registry.executeByCapability('unique-capability', { data: 'test' });

      expect(result.ok).toBe(true);
    });

    it('returns error when executing by unknown capability', async () => {
      const result = await registry.executeByCapability('unknown-capability', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillNotFoundError);
      }
    });

    it('returns error when initialization fails', async () => {
      const skill = createMockSkill({
        initialize: vi.fn(async () => {
          throw new Error('Init failed');
        }),
        isReady: () => false,
      });
      await registry.register(skill);

      const result = await registry.executeSkill('test-skill', {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SkillExecutionError);
        expect(result.error.message).toContain('initialize');
      }
    });
  });

  describe('Lifecycle', () => {
    it('initializes all skills', async () => {
      const skill1 = createMockSkill({ id: 'skill-1' });
      const skill2 = createMockSkill({ id: 'skill-2' });

      await registry.register(skill1);
      await registry.register(skill2);

      const result = await registry.initializeAll();

      expect(result.initialized).toBe(2);
      expect(result.failed).toBe(0);
      expect(skill1.initialize).toHaveBeenCalled();
      expect(skill2.initialize).toHaveBeenCalled();
    });

    it('counts failed initializations', async () => {
      const goodSkill = createMockSkill({ id: 'good' });
      const badSkill = createMockSkill({
        id: 'bad',
        initialize: vi.fn(async () => {
          throw new Error('Init failed');
        }),
      });

      await registry.register(goodSkill);
      await registry.register(badSkill);

      const result = await registry.initializeAll();

      expect(result.initialized).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('skips already initialized skills', async () => {
      const skill = createMockSkill({
        isReady: () => true,
      });
      await registry.register(skill);

      const result = await registry.initializeAll();

      expect(result.initialized).toBe(1);
      expect(skill.initialize).not.toHaveBeenCalled();
    });

    it('disposes all skills', async () => {
      const skill1 = createMockSkill({ id: 'skill-1' });
      const skill2 = createMockSkill({ id: 'skill-2' });

      await registry.register(skill1);
      await registry.register(skill2);

      await registry.disposeAll();

      expect(registry.size).toBe(0);
      expect(skill1.dispose).toHaveBeenCalled();
      expect(skill2.dispose).toHaveBeenCalled();
    });
  });

  describe('Context', () => {
    it('provides context with baseDir', () => {
      registry = new SkillsRegistry({ baseDir: '/custom/path' });

      const context = registry.getContext();

      expect(context.baseDir).toBe('/custom/path');
    });

    it('uses cwd as default baseDir', () => {
      const context = registry.getContext();

      expect(context.baseDir).toBe(process.cwd());
    });
  });

  describe('Error Events', () => {
    it('emits error event for skill not found', async () => {
      const errors: Array<{ error: Error; operation: string; skillId?: string }> = [];
      registry.on('error', (data) => errors.push(data));

      await registry.executeSkill('unknown', {});

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe('execute');
      expect(errors[0].skillId).toBe('unknown');
    });

    it('emits error event for execution failure', async () => {
      const skill = createMockSkill({
        execute: vi.fn(async () => {
          throw new Error('Boom');
        }),
      });
      await registry.register(skill);

      const errors: Array<{ error: Error; operation: string; skillId?: string }> = [];
      registry.on('error', (data) => errors.push(data));

      await registry.executeSkill('test-skill', {});

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe('execute');
      expect(errors[0].skillId).toBe('test-skill');
    });

    it('emits error event for auto-initialize failure', async () => {
      registry = new SkillsRegistry({ autoInitialize: true });
      const skill = createMockSkill({
        initialize: vi.fn(async () => {
          throw new Error('Init failed');
        }),
      });

      const errors: Array<{ error: Error; operation: string; skillId?: string }> = [];
      registry.on('error', (data) => errors.push(data));

      await registry.register(skill);

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe('auto-initialize');
      expect(errors[0].skillId).toBe('test-skill');
    });
  });
});
