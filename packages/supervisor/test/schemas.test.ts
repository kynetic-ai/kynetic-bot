/**
 * Tests for checkpoint and IPC message schemas
 *
 * @see @restart-checkpoint
 */

import { describe, it, expect } from 'vitest';
import {
  RestartReasonSchema,
  WakeContextSchema,
  CheckpointSchema,
  PlannedRestartMessageSchema,
  RestartAckMessageSchema,
  ErrorMessageSchema,
  IpcMessageSchema,
  type Checkpoint,
} from '../src/schemas.js';

describe('RestartReasonSchema', () => {
  // AC: @restart-checkpoint ac-3
  it('should accept valid restart reasons', () => {
    expect(RestartReasonSchema.parse('planned')).toBe('planned');
    expect(RestartReasonSchema.parse('upgrade')).toBe('upgrade');
    expect(RestartReasonSchema.parse('crash')).toBe('crash');
  });

  // AC: @restart-checkpoint ac-3
  it('should reject invalid restart reasons', () => {
    expect(() => RestartReasonSchema.parse('invalid')).toThrow();
    expect(() => RestartReasonSchema.parse('')).toThrow();
    expect(() => RestartReasonSchema.parse(null)).toThrow();
  });
});

describe('WakeContextSchema', () => {
  it('should accept valid wake context', () => {
    const valid = {
      prompt: 'Resume work on feature X',
      pending_work: 'Implement tests',
      instructions: 'Use TDD approach',
    };
    expect(WakeContextSchema.parse(valid)).toEqual(valid);
  });

  it('should accept wake context with only prompt', () => {
    const valid = { prompt: 'Resume work' };
    expect(WakeContextSchema.parse(valid)).toEqual(valid);
  });

  // AC: @trait-validated ac-1, ac-2
  it('should reject empty prompt', () => {
    const invalid = { prompt: '' };
    expect(() => WakeContextSchema.parse(invalid)).toThrow();
  });

  // AC: @trait-validated ac-2
  it('should reject missing prompt', () => {
    const invalid = {};
    expect(() => WakeContextSchema.parse(invalid)).toThrow();
  });
});

describe('CheckpointSchema', () => {
  const validCheckpoint: Checkpoint = {
    version: 1,
    session_id: '01HKXJ7Z3QXQXQXQXQXQXQXQXQ',
    restart_reason: 'planned',
    wake_context: {
      prompt: 'Resume implementation',
    },
    created_at: '2026-02-02T08:00:00.000Z',
  };

  // AC: @restart-checkpoint ac-2
  it('should accept valid checkpoint', () => {
    const result = CheckpointSchema.parse(validCheckpoint);
    expect(result.session_id).toBe(validCheckpoint.session_id);
    expect(result.restart_reason).toBe('planned');
    expect(result.wake_context.prompt).toBe('Resume implementation');
  });

  // AC: @restart-checkpoint ac-7
  it('should enforce version field', () => {
    const result = CheckpointSchema.parse(validCheckpoint);
    expect(result.version).toBe(1);
  });

  // AC: @restart-checkpoint ac-7
  it('should reject incompatible versions', () => {
    const invalid = { ...validCheckpoint, version: 2 };
    expect(() => CheckpointSchema.parse(invalid)).toThrow();
  });

  // AC: @trait-validated ac-2
  it('should reject missing required fields', () => {
    const { session_id, ...missing } = validCheckpoint;
    expect(() => CheckpointSchema.parse(missing)).toThrow();
  });

  // AC: @trait-validated ac-3
  it('should reject invalid session_id format', () => {
    const invalid = { ...validCheckpoint, session_id: 'not-a-ulid' };
    expect(() => CheckpointSchema.parse(invalid)).toThrow();
  });

  // AC: @restart-checkpoint ac-3
  it('should validate restart_reason enum', () => {
    const invalid = { ...validCheckpoint, restart_reason: 'invalid' };
    expect(() => CheckpointSchema.parse(invalid)).toThrow();
  });
});

describe('PlannedRestartMessageSchema', () => {
  it('should accept valid planned restart message', () => {
    const valid = {
      type: 'planned_restart' as const,
      checkpoint: '/path/to/checkpoint.yaml',
    };
    expect(PlannedRestartMessageSchema.parse(valid)).toEqual(valid);
  });

  // AC: @trait-validated ac-1
  it('should reject empty checkpoint path', () => {
    const invalid = { type: 'planned_restart' as const, checkpoint: '' };
    expect(() => PlannedRestartMessageSchema.parse(invalid)).toThrow();
  });

  // AC: @trait-validated ac-2
  it('should reject missing checkpoint field', () => {
    const invalid = { type: 'planned_restart' as const };
    expect(() => PlannedRestartMessageSchema.parse(invalid)).toThrow();
  });
});

describe('RestartAckMessageSchema', () => {
  it('should accept valid restart ack message', () => {
    const valid = { type: 'restart_ack' as const };
    expect(RestartAckMessageSchema.parse(valid)).toEqual(valid);
  });

  it('should reject messages with wrong type', () => {
    const invalid = { type: 'wrong_type' as const };
    expect(() => RestartAckMessageSchema.parse(invalid)).toThrow();
  });
});

describe('ErrorMessageSchema', () => {
  it('should accept valid error message', () => {
    const valid = {
      type: 'error' as const,
      message: 'Checkpoint file not found',
    };
    expect(ErrorMessageSchema.parse(valid)).toEqual(valid);
  });

  // AC: @trait-validated ac-1
  it('should reject empty error message', () => {
    const invalid = { type: 'error' as const, message: '' };
    expect(() => ErrorMessageSchema.parse(invalid)).toThrow();
  });
});

describe('IpcMessageSchema', () => {
  it('should accept all valid IPC message types', () => {
    const plannedRestart = {
      type: 'planned_restart' as const,
      checkpoint: '/path/to/checkpoint.yaml',
    };
    expect(IpcMessageSchema.parse(plannedRestart)).toEqual(plannedRestart);

    const ack = { type: 'restart_ack' as const };
    expect(IpcMessageSchema.parse(ack)).toEqual(ack);

    const error = { type: 'error' as const, message: 'Test error' };
    expect(IpcMessageSchema.parse(error)).toEqual(error);
  });

  // AC: @trait-validated ac-3
  it('should provide discriminated union errors', () => {
    const invalid = { type: 'invalid_type' as const };
    expect(() => IpcMessageSchema.parse(invalid)).toThrow();
  });
});
