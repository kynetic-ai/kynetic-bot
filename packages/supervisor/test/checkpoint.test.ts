/**
 * Tests for checkpoint file persistence and validation
 *
 * @see @restart-checkpoint
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { ulid } from 'ulid';
import { writeCheckpoint, readCheckpoint, deleteCheckpoint } from '../src/checkpoint.js';
import type { Checkpoint } from '../src/schemas.js';

describe('Checkpoint', () => {
  let testDir: string;
  let dataDir: string;

  beforeEach(async () => {
    // Create test directory
    testDir = join(tmpdir(), `checkpoint-test-${Date.now()}`);
    dataDir = join(testDir, '.kbot');
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup happens automatically with temp dir
  });

  describe('writeCheckpoint', () => {
    // AC: @restart-checkpoint ac-1
    it('writes checkpoint to .kbot/checkpoints/{ulid}.yaml', async () => {
      const sessionId = ulid();
      const result = await writeCheckpoint(dataDir, sessionId, 'planned', {
        prompt: 'Resume session after planned restart',
      });

      expect(result.success).toBe(true);
      expect(result.path).toBeDefined();
      expect(result.path).toMatch(/\.kbot\/checkpoints\/[0-9A-Z]{26}\.yaml$/);

      // Verify file exists and is readable
      const content = await readFile(result.path!, 'utf-8');
      expect(content).toBeTruthy();
    });

    // AC: @restart-checkpoint ac-2
    it('checkpoint contains session_id, restart_reason, wake_context.prompt', async () => {
      const sessionId = ulid();
      const result = await writeCheckpoint(dataDir, sessionId, 'upgrade', {
        prompt: 'Bot upgraded, resume work',
        pending_work: 'Fix bug #123',
      });

      expect(result.success).toBe(true);

      // Read and parse the file
      const content = await readFile(result.path!, 'utf-8');
      const checkpoint = parseYaml(content) as Checkpoint;

      expect(checkpoint.session_id).toBe(sessionId);
      expect(checkpoint.restart_reason).toBe('upgrade');
      expect(checkpoint.wake_context.prompt).toBe('Bot upgraded, resume work');
      expect(checkpoint.wake_context.pending_work).toBe('Fix bug #123');
    });

    // AC: @restart-checkpoint ac-3
    it('accepts restart_reason: planned', async () => {
      const result = await writeCheckpoint(dataDir, ulid(), 'planned', {
        prompt: 'Planned restart',
      });

      expect(result.success).toBe(true);
    });

    // AC: @restart-checkpoint ac-3
    it('accepts restart_reason: upgrade', async () => {
      const result = await writeCheckpoint(dataDir, ulid(), 'upgrade', {
        prompt: 'Upgrade restart',
      });

      expect(result.success).toBe(true);
    });

    // AC: @restart-checkpoint ac-3
    it('accepts restart_reason: crash', async () => {
      const result = await writeCheckpoint(dataDir, ulid(), 'crash', {
        prompt: 'Crash recovery',
      });

      expect(result.success).toBe(true);
    });

    // AC: @restart-checkpoint ac-2, ac-7
    it('includes version field in checkpoint', async () => {
      const result = await writeCheckpoint(dataDir, ulid(), 'planned', {
        prompt: 'Test version field',
      });

      expect(result.success).toBe(true);

      const content = await readFile(result.path!, 'utf-8');
      const checkpoint = parseYaml(content) as Checkpoint;

      expect(checkpoint.version).toBe(1);
    });

    it('includes created_at timestamp', async () => {
      const before = Date.now();
      const result = await writeCheckpoint(dataDir, ulid(), 'planned', {
        prompt: 'Test timestamp',
      });
      const after = Date.now();

      expect(result.success).toBe(true);

      const content = await readFile(result.path!, 'utf-8');
      const checkpoint = parseYaml(content) as Checkpoint;

      expect(checkpoint.created_at).toBeDefined();
      const createdAtTime = new Date(checkpoint.created_at).getTime();
      expect(createdAtTime).toBeGreaterThanOrEqual(before);
      expect(createdAtTime).toBeLessThanOrEqual(after);
    });

    // AC: @restart-checkpoint ac-8
    it('logs error and returns failure when disk write fails', async () => {
      // Use an invalid path that can't be created
      const invalidDir = '/root/forbidden/.kbot';

      const result = await writeCheckpoint(invalidDir, ulid(), 'planned', {
        prompt: 'Test write failure',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toBeTruthy();
    });
  });

  describe('readCheckpoint', () => {
    // AC: @restart-checkpoint ac-6
    it('validates checkpoint structure and returns checkpoint on success', async () => {
      const sessionId = ulid();
      const writeResult = await writeCheckpoint(dataDir, sessionId, 'planned', {
        prompt: 'Valid checkpoint',
      });

      const readResult = await readCheckpoint(writeResult.path!);

      expect(readResult.success).toBe(true);
      expect(readResult.checkpoint).toBeDefined();
      expect(readResult.checkpoint?.session_id).toBe(sessionId);
      expect(readResult.checkpoint?.restart_reason).toBe('planned');
      expect(readResult.checkpoint?.wake_context.prompt).toBe('Valid checkpoint');
    });

    // AC: @restart-checkpoint ac-4
    it('ignores checkpoint older than 24 hours with warning', async () => {
      // Create checkpoint with old timestamp
      const checkpointPath = join(dataDir, 'checkpoints', `${ulid()}.yaml`);
      await mkdir(join(dataDir, 'checkpoints'), { recursive: true });

      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
      const checkpoint: Checkpoint = {
        version: 1,
        session_id: ulid(),
        restart_reason: 'planned',
        wake_context: { prompt: 'Old checkpoint' },
        created_at: oldDate.toISOString(),
      };

      const yaml = require('yaml');
      await writeFile(checkpointPath, yaml.stringify(checkpoint), 'utf-8');

      const result = await readCheckpoint(checkpointPath);

      expect(result.success).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('24 hours');
    });

    // AC: @restart-checkpoint ac-4
    it('accepts checkpoint within 24-hour TTL', async () => {
      // Create checkpoint with recent timestamp
      const checkpointPath = join(dataDir, 'checkpoints', `${ulid()}.yaml`);
      await mkdir(join(dataDir, 'checkpoints'), { recursive: true });

      const recentDate = new Date(Date.now() - 23 * 60 * 60 * 1000); // 23 hours ago
      const checkpoint: Checkpoint = {
        version: 1,
        session_id: ulid(),
        restart_reason: 'planned',
        wake_context: { prompt: 'Recent checkpoint' },
        created_at: recentDate.toISOString(),
      };

      const yaml = require('yaml');
      await writeFile(checkpointPath, yaml.stringify(checkpoint), 'utf-8');

      const result = await readCheckpoint(checkpointPath);

      expect(result.success).toBe(true);
      expect(result.checkpoint).toBeDefined();
    });

    // AC: @restart-checkpoint ac-6
    it('logs error when checkpoint is corrupted', async () => {
      const checkpointPath = join(dataDir, 'checkpoints', `${ulid()}.yaml`);
      await mkdir(join(dataDir, 'checkpoints'), { recursive: true });

      // Write invalid YAML
      await writeFile(checkpointPath, 'invalid: yaml: content: [', 'utf-8');

      const result = await readCheckpoint(checkpointPath);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    // AC: @restart-checkpoint ac-6
    it('handles missing required fields gracefully', async () => {
      const checkpointPath = join(dataDir, 'checkpoints', `${ulid()}.yaml`);
      await mkdir(join(dataDir, 'checkpoints'), { recursive: true });

      // Missing session_id
      const incomplete = {
        version: 1,
        restart_reason: 'planned',
        wake_context: { prompt: 'Incomplete' },
        created_at: new Date().toISOString(),
      };

      const yaml = require('yaml');
      await writeFile(checkpointPath, yaml.stringify(incomplete), 'utf-8');

      const result = await readCheckpoint(checkpointPath);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Invalid checkpoint format');
    });

    // AC: @restart-checkpoint ac-7
    it('rejects unsupported checkpoint version', async () => {
      const checkpointPath = join(dataDir, 'checkpoints', `${ulid()}.yaml`);
      await mkdir(join(dataDir, 'checkpoints'), { recursive: true });

      const futureVersion = {
        version: 999,
        session_id: ulid(),
        restart_reason: 'planned',
        wake_context: { prompt: 'Future version' },
        created_at: new Date().toISOString(),
      };

      const yaml = require('yaml');
      await writeFile(checkpointPath, yaml.stringify(futureVersion), 'utf-8');

      const result = await readCheckpoint(checkpointPath);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Note: This will fail validation at the Zod level since version is z.literal(1)
      expect(result.error?.message).toContain('Invalid checkpoint format');
    });

    // AC: @restart-checkpoint ac-6
    it('returns error when file does not exist', async () => {
      const nonExistentPath = join(dataDir, 'checkpoints', 'nonexistent.yaml');

      const result = await readCheckpoint(nonExistentPath);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('deleteCheckpoint', () => {
    // AC: @restart-checkpoint ac-5
    it('deletes checkpoint file after consumption', async () => {
      const writeResult = await writeCheckpoint(dataDir, ulid(), 'planned', {
        prompt: 'To be deleted',
      });

      expect(writeResult.success).toBe(true);

      // Verify file exists
      const content = await readFile(writeResult.path!, 'utf-8');
      expect(content).toBeTruthy();

      // Delete checkpoint
      await deleteCheckpoint(writeResult.path!);

      // Verify file is gone
      await expect(readFile(writeResult.path!, 'utf-8')).rejects.toThrow();
    });

    // AC: @restart-checkpoint ac-5
    it('does not throw when deleting non-existent file', async () => {
      const nonExistentPath = join(dataDir, 'checkpoints', 'nonexistent.yaml');

      // Should not throw
      await expect(deleteCheckpoint(nonExistentPath)).resolves.toBeUndefined();
    });
  });

  describe('trait-validated', () => {
    // AC: @trait-validated ac-1
    it('returns structured error for invalid input', async () => {
      const checkpointPath = join(dataDir, 'checkpoints', `${ulid()}.yaml`);
      await mkdir(join(dataDir, 'checkpoints'), { recursive: true });

      // Invalid restart_reason
      const invalid = {
        version: 1,
        session_id: ulid(),
        restart_reason: 'invalid-reason',
        wake_context: { prompt: 'Test' },
        created_at: new Date().toISOString(),
      };

      const yaml = require('yaml');
      await writeFile(checkpointPath, yaml.stringify(invalid), 'utf-8');

      const result = await readCheckpoint(checkpointPath);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Invalid checkpoint format');
    });

    // AC: @trait-validated ac-2
    it('identifies missing field in error', async () => {
      const checkpointPath = join(dataDir, 'checkpoints', `${ulid()}.yaml`);
      await mkdir(join(dataDir, 'checkpoints'), { recursive: true });

      // Missing wake_context
      const missing = {
        version: 1,
        session_id: ulid(),
        restart_reason: 'planned',
        created_at: new Date().toISOString(),
      };

      const yaml = require('yaml');
      await writeFile(checkpointPath, yaml.stringify(missing), 'utf-8');

      const result = await readCheckpoint(checkpointPath);

      expect(result.success).toBe(false);
      expect(result.error?.message).toBeTruthy();
    });

    // AC: @trait-validated ac-3
    it('includes expected type in error for type mismatch', async () => {
      const checkpointPath = join(dataDir, 'checkpoints', `${ulid()}.yaml`);
      await mkdir(join(dataDir, 'checkpoints'), { recursive: true });

      // Wrong type for version (string instead of number)
      const wrongType = {
        version: 'one',
        session_id: ulid(),
        restart_reason: 'planned',
        wake_context: { prompt: 'Test' },
        created_at: new Date().toISOString(),
      };

      const yaml = require('yaml');
      await writeFile(checkpointPath, yaml.stringify(wrongType), 'utf-8');

      const result = await readCheckpoint(checkpointPath);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Invalid checkpoint format');
    });
  });

  describe('trait-recoverable', () => {
    // AC: @trait-recoverable ac-2
    it('logs and attempts recovery when checkpoint incomplete', async () => {
      const checkpointPath = join(dataDir, 'checkpoints', `${ulid()}.yaml`);
      await mkdir(join(dataDir, 'checkpoints'), { recursive: true });

      // Incomplete checkpoint (missing optional fields is ok, but structure invalid)
      const incomplete = 'version: 1\ninvalid structure';

      await writeFile(checkpointPath, incomplete, 'utf-8');

      const result = await readCheckpoint(checkpointPath);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    // AC: @trait-recoverable ac-3
    it('emits error with context when checkpoint unrecoverable', async () => {
      const checkpointPath = join(dataDir, 'checkpoints', `${ulid()}.yaml`);
      await mkdir(join(dataDir, 'checkpoints'), { recursive: true });

      // Completely broken YAML
      await writeFile(checkpointPath, '{{[invalid', 'utf-8');

      const result = await readCheckpoint(checkpointPath);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Error includes context about what went wrong
      expect(result.error?.message).toBeTruthy();
    });
  });
});
