/**
 * Shadow Branch Initialization
 *
 * Functions to create and repair kbot shadow branch worktree.
 */

import { exec, execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { KbotShadowInitResult, KbotShadowStatus } from './config.js';
import { KBOT_BRANCH_NAME, KBOT_WORKTREE_DIR } from './config.js';
import { getKbotShadowStatus, isGitRepo } from './detect.js';
import { KbotShadowError } from './errors.js';

const execAsync = promisify(exec);

/**
 * Options for shadow initialization
 */
export interface KbotShadowInitOptions {
  /** Custom worktree directory name */
  worktreeDir?: string;
  /** Custom branch name */
  branchName?: string;
  /** Force reinitialize even if exists */
  force?: boolean;
  /** Enable debug output */
  debug?: boolean;
}

/**
 * Check if .gitignore has uncommitted changes
 */
async function hasUncommittedGitignore(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync('git status --porcelain .gitignore', {
      cwd: projectRoot,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Add .kbot/ to .gitignore if not already present.
 * Commits the change after adding.
 */
async function ensureGitignore(
  projectRoot: string,
  worktreeDirName: string,
): Promise<boolean> {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const entry = `${worktreeDirName}/`;

  // Fail fast if .gitignore has uncommitted changes
  if (await hasUncommittedGitignore(projectRoot)) {
    throw new KbotShadowError(
      '.gitignore has uncommitted changes',
      'GIT_ERROR',
      'Commit or stash your .gitignore changes before initializing kbot shadow.',
    );
  }

  try {
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // File doesn't exist, will create
    }

    // Check if already present
    const lines = content.split('\n');
    const patterns = [
      worktreeDirName,
      `${worktreeDirName}/`,
      `/${worktreeDirName}`,
      `/${worktreeDirName}/`,
    ];

    for (const line of lines) {
      const trimmed = line.trim();
      if (patterns.includes(trimmed)) {
        return false; // Already present
      }
    }

    // Add to gitignore
    const newContent =
      content.endsWith('\n') || content === ''
        ? `${content}${entry}\n`
        : `${content}\n${entry}\n`;

    await fs.writeFile(gitignorePath, newContent, 'utf-8');

    // Commit the change
    await execAsync('git add .gitignore', { cwd: projectRoot });
    await execAsync(
      `git commit -m "chore: add ${worktreeDirName}/ to .gitignore for kbot memory"`,
      { cwd: projectRoot },
    );

    return true;
  } catch (error) {
    if (error instanceof KbotShadowError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new KbotShadowError(
      `Failed to update .gitignore: ${message}`,
      'GIT_ERROR',
      'Check file permissions for .gitignore',
    );
  }
}

/**
 * Initialize shadow branch and worktree.
 * Creates orphan branch, worktree, updates gitignore.
 *
 * @param projectRoot Git repository root
 * @param options Initialization options
 * @returns Result indicating what was created
 */
export async function initializeKbotShadow(
  projectRoot: string,
  options: KbotShadowInitOptions = {},
): Promise<KbotShadowInitResult> {
  const worktreeDirName = options.worktreeDir ?? KBOT_WORKTREE_DIR;
  const branchName = options.branchName ?? KBOT_BRANCH_NAME;

  const result: KbotShadowInitResult = {
    success: false,
    branchCreated: false,
    worktreeCreated: false,
    gitignoreUpdated: false,
    initialCommit: false,
    alreadyExists: false,
  };

  // Check if we're in a git repo
  if (!isGitRepo(projectRoot)) {
    result.error = 'Not a git repository';
    return result;
  }

  const worktreeDir = path.join(projectRoot, worktreeDirName);

  // Check current status
  const status = await getKbotShadowStatus(projectRoot, {
    worktreeDir: worktreeDirName,
    branchName,
  });

  // Handle existing shadow branch
  if (status.healthy && !options.force) {
    result.alreadyExists = true;
    result.success = true;
    return result;
  }

  try {
    // Step 1: Update .gitignore first (before creating .kbot/)
    result.gitignoreUpdated = await ensureGitignore(projectRoot, worktreeDirName);

    // Step 2: Create worktree with orphan branch (or attach to existing branch)
    if (!status.worktreeExists || !status.worktreeLinked) {
      // Remove existing directory if present but not linked
      if (status.worktreeExists && !status.worktreeLinked) {
        await fs.rm(worktreeDir, { recursive: true, force: true });
      }

      // Remove stale worktree reference if any
      try {
        await execAsync(`git worktree remove ${worktreeDirName} --force`, {
          cwd: projectRoot,
        });
      } catch {
        // Ignore - worktree may not exist in git's list
      }

      if (!status.branchExists) {
        // Create orphan branch with worktree
        await execAsync(
          `git worktree add --orphan -b ${branchName} ${worktreeDirName}`,
          { cwd: projectRoot },
        );
        result.branchCreated = true;
      } else {
        // Attach to existing local branch
        await execAsync(
          `git worktree add ${worktreeDirName} ${branchName}`,
          { cwd: projectRoot },
        );
      }

      result.worktreeCreated = true;
    }

    // Step 3: Create initial files if new branch
    if (result.branchCreated) {
      const initMarkerPath = path.join(worktreeDir, '.kbot-init');
      await fs.writeFile(
        initMarkerPath,
        `# Kbot Memory Storage\n# Initialized: ${new Date().toISOString()}\n`,
        'utf-8',
      );

      // Create .gitignore to exclude lock file (prevents tracking issues)
      const worktreeGitignorePath = path.join(worktreeDir, '.gitignore');
      await fs.writeFile(worktreeGitignorePath, '.kbot-lock\n', 'utf-8');

      // Initial commit
      execSync('git add -A', { cwd: worktreeDir, stdio: ['pipe', 'pipe', 'pipe'] });
      try {
        execSync('git diff --cached --quiet', {
          cwd: worktreeDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Has changes, commit them
        execSync('git commit -m "Initialize kbot memory storage"', {
          cwd: worktreeDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        result.initialCommit = true;
      }
    }

    result.success = true;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

/**
 * Repair a broken shadow branch setup.
 * Handles cases where worktree is disconnected or directory is missing.
 *
 * @param projectRoot Git repository root
 * @param options Repair options
 * @returns Result indicating what was repaired
 */
export async function repairKbotShadow(
  projectRoot: string,
  options?: { worktreeDir?: string; branchName?: string },
): Promise<KbotShadowInitResult> {
  const worktreeDirName = options?.worktreeDir ?? KBOT_WORKTREE_DIR;
  const branchName = options?.branchName ?? KBOT_BRANCH_NAME;

  const status = await getKbotShadowStatus(projectRoot, {
    worktreeDir: worktreeDirName,
    branchName,
  });

  if (status.healthy) {
    return {
      success: true,
      branchCreated: false,
      worktreeCreated: false,
      gitignoreUpdated: false,
      initialCommit: false,
      alreadyExists: true,
    };
  }

  if (!status.branchExists) {
    // Can't repair without a branch - need full init
    return {
      success: false,
      branchCreated: false,
      worktreeCreated: false,
      gitignoreUpdated: false,
      initialCommit: false,
      alreadyExists: false,
      error: 'Shadow branch does not exist. Run full initialization instead.',
    };
  }

  // Branch exists but worktree is broken - repair it
  const worktreeDir = path.join(projectRoot, worktreeDirName);

  try {
    // Remove stale worktree reference
    try {
      await execAsync(`git worktree remove ${worktreeDirName} --force`, {
        cwd: projectRoot,
      });
    } catch {
      // Ignore - worktree may not be in git's list
    }

    // Remove directory if exists
    await fs.rm(worktreeDir, { recursive: true, force: true });

    // Prune stale worktree references
    try {
      await execAsync('git worktree prune', { cwd: projectRoot });
    } catch {
      // Ignore - prune is best-effort
    }

    // Recreate worktree
    await execAsync(`git worktree add ${worktreeDirName} ${branchName}`, {
      cwd: projectRoot,
    });

    return {
      success: true,
      branchCreated: false,
      worktreeCreated: true,
      gitignoreUpdated: false,
      initialCommit: false,
      alreadyExists: false,
    };
  } catch (error) {
    return {
      success: false,
      branchCreated: false,
      worktreeCreated: false,
      gitignoreUpdated: false,
      initialCommit: false,
      alreadyExists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create error based on shadow status
 */
export function createKbotShadowError(status: KbotShadowStatus): KbotShadowError {
  if (!status.branchExists && !status.worktreeExists) {
    return new KbotShadowError(
      'Kbot shadow branch not initialized',
      'NOT_INITIALIZED',
      'The .kbot/ memory storage will be auto-created on first use.',
    );
  }

  if (status.branchExists && !status.worktreeExists) {
    return new KbotShadowError(
      '.kbot/ directory missing',
      'DIRECTORY_MISSING',
      'Run repair to recreate the worktree.',
    );
  }

  if (status.worktreeExists && !status.worktreeLinked) {
    return new KbotShadowError(
      'Worktree disconnected from git',
      'WORKTREE_DISCONNECTED',
      'Run repair to fix the worktree link.',
    );
  }

  return new KbotShadowError(
    status.error || 'Unknown shadow branch error',
    'GIT_ERROR',
    'Check git status and try repair.',
  );
}
