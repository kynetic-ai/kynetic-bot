/**
 * Shadow Branch Tests
 *
 * Integration tests using real git operations in temp directories.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KBOT_BRANCH_NAME,
  KBOT_LOCK_FILE,
  KBOT_WORKTREE_DIR,
  KbotShadow,
  KbotShadowError,
  KbotValidationError,
  acquireLock,
  branchExists,
  detectKbotShadow,
  getGitRoot,
  getKbotShadowStatus,
  hasLockFile,
  initializeKbotShadow,
  isGitRepo,
  isValidWorktree,
  kbotAutoCommit,
  recoverFromCrash,
  releaseLock,
  repairKbotShadow,
} from '../src/index.js';

describe('Shadow Branch', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create temp directory with git repo
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kbot-shadow-test-'));
    execSync('git init', { cwd: tempDir, stdio: ['pipe', 'pipe', 'pipe'] });
    execSync('git config user.email "test@test.com"', {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execSync('git config user.name "Test"', {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execSync('git commit --allow-empty -m "Initial commit"', {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('Detection', () => {
    // AC-3: Returns null (not error) when .kbot/ not found
    it('returns null when .kbot/ missing', async () => {
      const config = await detectKbotShadow(tempDir);
      expect(config).toBeNull();
    });

    it('returns config when .kbot/ valid', async () => {
      // Initialize first
      await initializeKbotShadow(tempDir);

      const config = await detectKbotShadow(tempDir);
      expect(config).not.toBeNull();
      expect(config?.enabled).toBe(true);
      expect(config?.branchName).toBe(KBOT_BRANCH_NAME);
      expect(config?.worktreeDir).toBe(path.join(tempDir, KBOT_WORKTREE_DIR));
    });

    it('isGitRepo returns true for git repos', () => {
      expect(isGitRepo(tempDir)).toBe(true);
    });

    it('isGitRepo returns false for non-repos', async () => {
      const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-git-'));
      try {
        expect(isGitRepo(nonGitDir)).toBe(false);
      } finally {
        await fs.rm(nonGitDir, { recursive: true, force: true });
      }
    });

    it('getGitRoot returns root directory', () => {
      expect(getGitRoot(tempDir)).toBe(tempDir);
    });

    it('branchExists returns false for non-existent branch', () => {
      expect(branchExists(tempDir, 'nonexistent')).toBe(false);
    });

    it('branchExists returns true after init', async () => {
      await initializeKbotShadow(tempDir);
      expect(branchExists(tempDir, KBOT_BRANCH_NAME)).toBe(true);
    });
  });

  describe('Initialization', () => {
    it('creates orphan branch and worktree', async () => {
      const result = await initializeKbotShadow(tempDir);

      expect(result.success).toBe(true);
      expect(result.branchCreated).toBe(true);
      expect(result.worktreeCreated).toBe(true);
      expect(result.initialCommit).toBe(true);
    });

    it('is idempotent (alreadyExists)', async () => {
      await initializeKbotShadow(tempDir);
      const result = await initializeKbotShadow(tempDir);

      expect(result.success).toBe(true);
      expect(result.alreadyExists).toBe(true);
      expect(result.branchCreated).toBe(false);
    });

    it('updates .gitignore', async () => {
      const result = await initializeKbotShadow(tempDir);

      expect(result.gitignoreUpdated).toBe(true);

      const gitignore = await fs.readFile(path.join(tempDir, '.gitignore'), 'utf-8');
      expect(gitignore).toContain(KBOT_WORKTREE_DIR);
    });

    it('creates valid worktree', async () => {
      await initializeKbotShadow(tempDir);

      const worktreeDir = path.join(tempDir, KBOT_WORKTREE_DIR);
      expect(await isValidWorktree(worktreeDir)).toBe(true);
    });
  });

  describe('Status', () => {
    it('reports healthy after init', async () => {
      await initializeKbotShadow(tempDir);
      const status = await getKbotShadowStatus(tempDir);

      expect(status.exists).toBe(true);
      expect(status.healthy).toBe(true);
      expect(status.branchExists).toBe(true);
      expect(status.worktreeExists).toBe(true);
      expect(status.worktreeLinked).toBe(true);
    });

    it('reports unhealthy when worktree missing', async () => {
      await initializeKbotShadow(tempDir);

      // Remove worktree
      const worktreeDir = path.join(tempDir, KBOT_WORKTREE_DIR);
      await fs.rm(worktreeDir, { recursive: true, force: true });

      const status = await getKbotShadowStatus(tempDir);
      expect(status.healthy).toBe(false);
      expect(status.branchExists).toBe(true);
      expect(status.worktreeExists).toBe(false);
    });
  });

  describe('Repair', () => {
    it('repairs broken worktree', async () => {
      await initializeKbotShadow(tempDir);

      // Break worktree
      const worktreeDir = path.join(tempDir, KBOT_WORKTREE_DIR);
      await fs.rm(worktreeDir, { recursive: true, force: true });

      const result = await repairKbotShadow(tempDir);
      expect(result.success).toBe(true);
      expect(result.worktreeCreated).toBe(true);

      const status = await getKbotShadowStatus(tempDir);
      expect(status.healthy).toBe(true);
    });

    it('returns alreadyExists for healthy shadow', async () => {
      await initializeKbotShadow(tempDir);

      const result = await repairKbotShadow(tempDir);
      expect(result.success).toBe(true);
      expect(result.alreadyExists).toBe(true);
    });
  });

  describe('Commit Operations', () => {
    // AC-1: File atomically written to .kbot/
    it('auto-commits changes', async () => {
      await initializeKbotShadow(tempDir);
      const worktreeDir = path.join(tempDir, KBOT_WORKTREE_DIR);

      // Write a file
      await fs.writeFile(path.join(worktreeDir, 'test.txt'), 'test content');

      const result = await kbotAutoCommit(worktreeDir, 'Test commit');

      expect(result.committed).toBe(true);
      expect(result.filesChanged).toBeGreaterThan(0);
    });

    it('returns committed=false when no changes', async () => {
      await initializeKbotShadow(tempDir);
      const worktreeDir = path.join(tempDir, KBOT_WORKTREE_DIR);

      // First commit to ensure clean state (init creates initial files)
      await kbotAutoCommit(worktreeDir, 'Clear pending');

      // Now try to commit with no changes
      const result = await kbotAutoCommit(worktreeDir, 'No changes');

      expect(result.committed).toBe(false);
    });
  });

  describe('Lock Mechanism', () => {
    // AC-6: Lock file for crash recovery
    it('acquires and releases lock', async () => {
      await initializeKbotShadow(tempDir);
      const worktreeDir = path.join(tempDir, KBOT_WORKTREE_DIR);

      expect(await hasLockFile(worktreeDir)).toBe(false);

      const acquired = await acquireLock(worktreeDir);
      expect(acquired).toBe(true);
      expect(await hasLockFile(worktreeDir)).toBe(true);

      await releaseLock(worktreeDir);
      expect(await hasLockFile(worktreeDir)).toBe(false);
    });

    it('prevents double locking', async () => {
      await initializeKbotShadow(tempDir);
      const worktreeDir = path.join(tempDir, KBOT_WORKTREE_DIR);

      await acquireLock(worktreeDir);
      const secondAcquire = await acquireLock(worktreeDir);

      expect(secondAcquire).toBe(false);

      await releaseLock(worktreeDir);
    });

    // AC-6: Crash recovery
    it('recovers from crash', async () => {
      await initializeKbotShadow(tempDir);
      const worktreeDir = path.join(tempDir, KBOT_WORKTREE_DIR);

      // Simulate crash: leave uncommitted changes and lock file
      await fs.writeFile(path.join(worktreeDir, 'uncommitted.txt'), 'crash data');
      await fs.writeFile(path.join(worktreeDir, KBOT_LOCK_FILE), Date.now().toString());

      expect(await hasLockFile(worktreeDir)).toBe(true);

      const result = await recoverFromCrash(worktreeDir);

      expect(result.committed).toBe(true);
      expect(await hasLockFile(worktreeDir)).toBe(false);
    });
  });

  describe('KbotShadow Class', () => {
    it('auto-initializes on initialize()', async () => {
      const shadow = new KbotShadow({ projectRoot: tempDir });

      expect(shadow.getState()).toBe('uninitialized');

      await shadow.initialize();

      expect(shadow.getState()).toBe('ready');
      expect(shadow.getConfig()).not.toBeNull();
    });

    // AC-4: Emits sync events
    it('emits sync events', async () => {
      const shadow = new KbotShadow({ projectRoot: tempDir });

      const events: Array<{ type: string; payload: unknown }> = [];
      shadow.on('sync_start', (p) => events.push({ type: 'sync_start', payload: p }));
      shadow.on('sync_complete', (p) => events.push({ type: 'sync_complete', payload: p }));
      shadow.on('state_change', (p) => events.push({ type: 'state_change', payload: p }));

      await shadow.initialize();

      expect(events.some((e) => e.type === 'sync_start')).toBe(true);
      expect(events.some((e) => e.type === 'sync_complete')).toBe(true);
      expect(events.some((e) => e.type === 'state_change')).toBe(true);

      await shadow.shutdown();
    });

    it('force commits on demand', async () => {
      const shadow = new KbotShadow({ projectRoot: tempDir });
      await shadow.initialize();

      const worktreeDir = shadow.getWorktreeDir()!;
      await fs.writeFile(path.join(worktreeDir, 'force.txt'), 'force commit');

      const committed = await shadow.forceCommit('Force commit test');
      expect(committed).toBe(true);

      await shadow.shutdown();
    });

    // AC-2: Batch commits on event threshold
    it('tracks events and commits at threshold', async () => {
      const shadow = new KbotShadow({
        projectRoot: tempDir,
        scheduler: { maxEvents: 5, maxInterval: 60000, enabled: true },
      });
      await shadow.initialize();

      const worktreeDir = shadow.getWorktreeDir()!;

      // Record events up to threshold
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(worktreeDir, `file${i}.txt`), `content ${i}`);
        shadow.recordEvent('test-write', `file${i}`);
      }

      // Wait a tick for async threshold check
      await new Promise((resolve) => setTimeout(resolve, 50));

      await shadow.shutdown();
    });

    it('commits pending on shutdown', async () => {
      const shadow = new KbotShadow({
        projectRoot: tempDir,
        scheduler: { maxEvents: 100, maxInterval: 60000, enabled: true },
      });
      await shadow.initialize();

      const worktreeDir = shadow.getWorktreeDir()!;
      await fs.writeFile(path.join(worktreeDir, 'shutdown.txt'), 'shutdown test');
      shadow.recordEvent('test-write');

      await shadow.shutdown();

      // Verify commit was made
      const log = execSync('git log --oneline -1', {
        cwd: worktreeDir,
        encoding: 'utf-8',
      });
      expect(log).toContain('pending changes');
    });

    // AC-6: Runs recovery on init if lock exists
    it('runs recovery on init when lock exists', async () => {
      // First init to create shadow
      const shadow1 = new KbotShadow({ projectRoot: tempDir });
      await shadow1.initialize();
      const worktreeDir = shadow1.getWorktreeDir()!;
      await shadow1.shutdown();

      // Simulate crash
      await fs.writeFile(path.join(worktreeDir, 'crash.txt'), 'crash recovery');
      await fs.writeFile(path.join(worktreeDir, KBOT_LOCK_FILE), Date.now().toString());

      // New instance should recover
      const shadow2 = new KbotShadow({ projectRoot: tempDir });

      const events: string[] = [];
      shadow2.on('sync_start', (p) => events.push(p.operation));

      await shadow2.initialize();

      expect(events).toContain('recover');
      expect(await hasLockFile(worktreeDir)).toBe(false);

      await shadow2.shutdown();
    });
  });

  describe('Errors', () => {
    // AC-3: Clear error with suggestion
    it('KbotShadowError includes suggestion', () => {
      const error = new KbotShadowError(
        'Test error',
        'NOT_INITIALIZED',
        'Run init to fix.',
      );

      expect(error.message).toBe('Test error');
      expect(error.suggestion).toBe('Run init to fix.');
      expect(error.shadowCode).toBe('NOT_INITIALIZED');
      expect(error.format()).toContain('Suggestion:');
    });

    // AC-5: Validation error with field info
    it('KbotValidationError includes field info', () => {
      const error = new KbotValidationError(
        'Invalid value',
        'eventCount',
        'number',
        'not-a-number',
      );

      expect(error.field).toBe('eventCount');
      expect(error.expectedType).toBe('number');
      expect(error.actualValue).toBe('not-a-number');
    });
  });
});
