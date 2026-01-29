/**
 * Shadow Branch Commit Operations
 *
 * Functions for auto-committing changes to the shadow branch.
 * Includes lock file mechanism for crash recovery.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { KbotShadowConfig } from './config.js';
import { KBOT_LOCK_FILE } from './config.js';
import { KbotShadowError } from './errors.js';

/**
 * Result of a commit operation
 */
export interface KbotCommitResult {
  /** Whether commit was made */
  committed: boolean;
  /** Number of files changed */
  filesChanged: number;
  /** The commit message used */
  message?: string;
  /** Error if commit failed */
  error?: Error;
}

/**
 * Check if debug mode is enabled via environment
 */
function isDebugMode(debug?: boolean): boolean {
  if (debug === true) return true;
  if (process.env.KBOT_DEBUG === '1') return true;
  return false;
}

/**
 * Acquire lock for commit operation.
 * Returns true if lock acquired, false if already locked.
 * Uses atomic file creation to prevent race conditions.
 *
 * AC-6: Lock file for crash recovery
 */
export async function acquireLock(worktreeDir: string): Promise<boolean> {
  const lockPath = path.join(worktreeDir, KBOT_LOCK_FILE);

  // Check for stale lock first
  try {
    const stat = await fs.stat(lockPath);
    const age = Date.now() - stat.mtimeMs;
    if (age >= 300000) {
      // Stale lock (>= 5 minutes old) - remove it
      await fs.rm(lockPath);
    } else {
      // Lock is fresh - another operation in progress
      return false;
    }
  } catch {
    // Lock doesn't exist - good, proceed to create
  }

  // Atomic lock creation using exclusive flag
  // This prevents race conditions between stat and writeFile
  try {
    await fs.writeFile(lockPath, Date.now().toString(), { flag: 'wx' });
    return true;
  } catch (err) {
    // EEXIST means another process created the lock first
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

/**
 * Release the commit lock
 */
export async function releaseLock(worktreeDir: string): Promise<void> {
  const lockPath = path.join(worktreeDir, KBOT_LOCK_FILE);
  try {
    await fs.rm(lockPath);
  } catch {
    // Lock already removed
  }
}

/**
 * Check if a lock file exists (for recovery detection)
 *
 * AC-6: Detect crash during batch commit
 */
export async function hasLockFile(worktreeDir: string): Promise<boolean> {
  const lockPath = path.join(worktreeDir, KBOT_LOCK_FILE);
  try {
    await fs.access(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count staged files
 */
function countStagedFiles(worktreeDir: string): number {
  try {
    const output = execSync('git diff --cached --name-only', {
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const files = output.trim().split('\n').filter(Boolean);
    return files.length;
  } catch {
    return 0;
  }
}

/**
 * Auto-commit changes to shadow branch.
 * Called after write operations when shadow is enabled.
 *
 * AC-1: File atomically written to .kbot/
 *
 * @param worktreeDir Path to .kbot/ directory
 * @param message Commit message
 * @param debug Enable debug output
 * @returns Result indicating if commit was made
 */
export async function kbotAutoCommit(
  worktreeDir: string,
  message: string,
  debug?: boolean,
): Promise<KbotCommitResult> {
  const isDebug = isDebugMode(debug);
  const result: KbotCommitResult = {
    committed: false,
    filesChanged: 0,
  };

  // Acquire lock for crash recovery
  const lockAcquired = await acquireLock(worktreeDir);
  if (!lockAcquired) {
    result.error = new KbotShadowError(
      'Could not acquire commit lock - another operation in progress',
      'COMMIT_FAILED',
      'Wait for the current operation to complete or check for stale lock files.',
    );
    return result;
  }

  try {
    if (isDebug) {
      console.error(`[KBOT DEBUG] Auto-commit: git add -A (cwd: ${worktreeDir})`);
    }

    // Stage all changes
    execSync('git add -A', {
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Count staged files
    result.filesChanged = countStagedFiles(worktreeDir);

    // Check if there are staged changes
    try {
      if (isDebug) {
        console.error('[KBOT DEBUG] Auto-commit: git diff --cached --quiet');
      }

      execSync('git diff --cached --quiet', {
        cwd: worktreeDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // No error = no changes
      if (isDebug) {
        console.error('[KBOT DEBUG] Auto-commit: No changes to commit');
      }
      return result;
    } catch {
      // Error = there are changes, proceed with commit
    }

    if (isDebug) {
      console.error(`[KBOT DEBUG] Auto-commit: git commit -m "${message}"`);
    }

    // Commit with message
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KBOT_SHADOW_COMMIT: '1' },
    });

    result.committed = true;
    result.message = message;

    if (isDebug) {
      console.error('[KBOT DEBUG] Auto-commit: Success');
    }

    return result;
  } catch (error) {
    result.error = error instanceof Error ? error : new Error(String(error));
    if (isDebug) {
      console.error('[KBOT DEBUG] Auto-commit failed:', error);
    }
    return result;
  } finally {
    // Always release lock
    await releaseLock(worktreeDir);
  }
}

/**
 * Generate commit message for an operation
 */
export function generateCommitMessage(operation: string, ref?: string, detail?: string): string {
  const parts: string[] = [];

  switch (operation) {
    case 'memory-write':
      parts.push('Update memory');
      if (ref) parts.push(`: ${ref}`);
      break;
    case 'memory-batch':
      parts.push('Batch memory update');
      if (detail) parts.push(` (${detail})`);
      break;
    case 'recovery':
      parts.push('Recover from crash');
      break;
    default:
      parts.push(operation);
      if (ref) parts.push(` ${ref}`);
  }

  return parts.join('');
}

/**
 * Commit changes to shadow branch if enabled.
 * This is the primary interface for triggering auto-commit.
 *
 * @param shadowConfig Shadow configuration
 * @param operation Operation type
 * @param ref Reference (optional)
 * @param detail Additional detail (optional)
 * @param debug Enable debug output
 * @returns true if committed, false if shadow not enabled or nothing to commit
 */
export async function commitIfKbotShadow(
  shadowConfig: KbotShadowConfig | null,
  operation: string,
  ref?: string,
  detail?: string,
  debug?: boolean,
): Promise<boolean> {
  if (!shadowConfig?.enabled) {
    return false;
  }

  const message = generateCommitMessage(operation, ref, detail);
  const result = await kbotAutoCommit(shadowConfig.worktreeDir, message, debug);

  return result.committed;
}

/**
 * Check if there are any uncommitted changes (staged, unstaged, or untracked)
 */
function hasUncommittedChanges(worktreeDir: string): boolean {
  try {
    // Check for any changes including untracked files
    const status = execSync('git status --porcelain', {
      cwd: worktreeDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Recover from a crashed commit.
 * Called when lock file is found on startup.
 *
 * AC-6: Recovers from last successful commit
 */
export async function recoverFromCrash(
  worktreeDir: string,
  debug?: boolean,
): Promise<KbotCommitResult> {
  const isDebug = isDebugMode(debug);

  if (isDebug) {
    console.error('[KBOT DEBUG] Recovering from crash - found lock file');
  }

  // Remove stale lock
  await releaseLock(worktreeDir);

  // Check for uncommitted changes (including untracked files)
  if (!hasUncommittedChanges(worktreeDir)) {
    // No changes - nothing to recover
    return { committed: false, filesChanged: 0 };
  }

  // Stage and commit recovery
  return kbotAutoCommit(worktreeDir, 'Recover from interrupted operation', debug);
}
