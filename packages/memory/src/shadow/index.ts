/**
 * Shadow Branch Module
 *
 * Provides persistent storage via git shadow branch worktree.
 */

// Errors
export { KbotShadowError, KbotValidationError } from './errors.js';

// Config types and constants
export type {
  KbotShadowConfig,
  KbotShadowStatus,
  KbotSchedulerConfig,
  KbotShadowState,
  KbotShadowOptions,
  KbotShadowInitResult,
  KbotShadowEvents,
} from './config.js';

export {
  KBOT_BRANCH_NAME,
  KBOT_WORKTREE_DIR,
  KBOT_LOCK_FILE,
  DEFAULT_SCHEDULER_CONFIG,
} from './config.js';

// Detection functions
export {
  detectKbotShadow,
  getKbotShadowStatus,
  isGitRepo,
  getGitRoot,
  branchExists,
  isValidWorktree,
  detectRunningFromShadowWorktree,
} from './detect.js';

// Initialization functions
export {
  initializeKbotShadow,
  repairKbotShadow,
  createKbotShadowError,
} from './init.js';
export type { KbotShadowInitOptions } from './init.js';

// Commit functions
export {
  kbotAutoCommit,
  commitIfKbotShadow,
  generateCommitMessage,
  acquireLock,
  releaseLock,
  hasLockFile,
  recoverFromCrash,
} from './commit.js';
export type { KbotCommitResult } from './commit.js';

// Main class
export { KbotShadow } from './shadow.js';
