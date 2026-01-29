/**
 * Shadow Branch Detection
 *
 * Functions to detect and validate kbot shadow branch configuration.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { KbotShadowConfig, KbotShadowStatus } from './config.js';
import { KBOT_BRANCH_NAME, KBOT_WORKTREE_DIR } from './config.js';

/**
 * Check if we're in a git repository
 */
export function isGitRepo(dir: string): boolean {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git root directory
 */
export function getGitRoot(dir: string): string | null {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    }).trim();
    return result;
  } catch {
    return null;
  }
}

/**
 * Check if a branch exists
 */
export function branchExists(dir: string, branchName: string): boolean {
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${branchName}`, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a directory is a valid git worktree
 */
export async function isValidWorktree(worktreeDir: string): Promise<boolean> {
  try {
    // Check if .git file exists (worktrees have a .git file, not directory)
    const gitPath = path.join(worktreeDir, '.git');
    const stat = await fs.stat(gitPath);

    if (stat.isFile()) {
      // Read the .git file to verify it points to a worktree
      const content = await fs.readFile(gitPath, 'utf-8');
      return content.trim().startsWith('gitdir:');
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Detect shadow branch configuration from a directory.
 * Returns shadow config if .kbot/ exists and is valid, null otherwise.
 *
 * AC-3: Returns null (not error) when .kbot/ not found
 */
export async function detectKbotShadow(
  startDir: string,
  options?: { worktreeDir?: string; branchName?: string },
): Promise<KbotShadowConfig | null> {
  const worktreeDirName = options?.worktreeDir ?? KBOT_WORKTREE_DIR;
  const branchName = options?.branchName ?? KBOT_BRANCH_NAME;

  const gitRoot = getGitRoot(startDir);
  if (!gitRoot) {
    return null;
  }

  const worktreeDir = path.join(gitRoot, worktreeDirName);

  try {
    await fs.access(worktreeDir);

    // Verify it's a valid worktree
    if (await isValidWorktree(worktreeDir)) {
      return {
        enabled: true,
        worktreeDir,
        branchName,
        projectRoot: gitRoot,
      };
    }

    // Directory exists but not a valid worktree
    return null;
  } catch {
    // .kbot/ doesn't exist
    return null;
  }
}

/**
 * Get detailed shadow branch status
 */
export async function getKbotShadowStatus(
  projectRoot: string,
  options?: { worktreeDir?: string; branchName?: string },
): Promise<KbotShadowStatus> {
  const worktreeDirName = options?.worktreeDir ?? KBOT_WORKTREE_DIR;
  const branchName = options?.branchName ?? KBOT_BRANCH_NAME;
  const worktreeDir = path.join(projectRoot, worktreeDirName);

  const status: KbotShadowStatus = {
    exists: false,
    healthy: false,
    branchExists: false,
    worktreeExists: false,
    worktreeLinked: false,
  };

  // Check if we're in a git repo
  if (!isGitRepo(projectRoot)) {
    status.error = 'Not a git repository';
    return status;
  }

  // Check if branch exists
  status.branchExists = branchExists(projectRoot, branchName);

  // Check if worktree directory exists
  try {
    await fs.access(worktreeDir);
    status.worktreeExists = true;
  } catch {
    status.worktreeExists = false;
  }

  // Check if worktree is properly linked
  if (status.worktreeExists) {
    status.worktreeLinked = await isValidWorktree(worktreeDir);
  }

  // Determine overall status
  status.exists = status.branchExists || status.worktreeExists;
  status.healthy = status.branchExists && status.worktreeExists && status.worktreeLinked;

  if (!status.healthy && status.exists) {
    if (!status.branchExists) {
      status.error = 'Shadow branch missing but worktree exists';
    } else if (!status.worktreeExists) {
      status.error = 'Shadow branch exists but worktree missing';
    } else if (!status.worktreeLinked) {
      status.error = 'Worktree exists but not properly linked';
    }
  }

  return status;
}

/**
 * Check if running from inside the shadow worktree directory.
 * Returns the main project root if detected, null otherwise.
 */
export async function detectRunningFromShadowWorktree(
  cwd: string,
  worktreeDirName: string = KBOT_WORKTREE_DIR,
): Promise<string | null> {
  try {
    const gitPath = path.join(cwd, '.git');
    const stat = await fs.stat(gitPath);

    // Worktrees have a .git file, not directory
    if (!stat.isFile()) {
      return null;
    }

    const content = await fs.readFile(gitPath, 'utf-8');
    const match = content.trim().match(/^gitdir:\s*(.+)$/);
    if (!match) {
      return null;
    }

    const gitdir = match[1];

    // Check if this is a shadow worktree
    if (gitdir.includes('.git/worktrees/')) {
      const worktreesMatch = gitdir.match(/^(.+)\/\.git\/worktrees\//);
      if (worktreesMatch) {
        const mainProjectRoot = worktreesMatch[1];
        const cwdBase = path.basename(cwd);
        const worktreeName = path.basename(gitdir);

        if (cwdBase === worktreeDirName || worktreeName.includes('kbot')) {
          return mainProjectRoot;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
