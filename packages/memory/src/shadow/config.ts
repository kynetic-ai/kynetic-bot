/**
 * Shadow Branch Configuration Types and Constants
 *
 * Defines types, interfaces, and constants for kbot shadow branch operations.
 */

/**
 * Default shadow branch name
 */
export const KBOT_BRANCH_NAME = 'kbot-memory';

/**
 * Default shadow worktree directory
 */
export const KBOT_WORKTREE_DIR = '.kbot';

/**
 * Lock file name for crash recovery
 */
export const KBOT_LOCK_FILE = '.kbot-lock';

/**
 * Shadow branch configuration
 */
export interface KbotShadowConfig {
  /** Whether shadow branch is enabled/detected */
  enabled: boolean;
  /** Path to .kbot/ worktree directory */
  worktreeDir: string;
  /** Shadow branch name (default: kbot-memory) */
  branchName: string;
  /** Project root (where .kbot/ lives) */
  projectRoot: string;
}

/**
 * Shadow branch status for health checks
 */
export interface KbotShadowStatus {
  /** Whether any shadow infrastructure exists */
  exists: boolean;
  /** Whether shadow is fully functional */
  healthy: boolean;
  /** Whether the shadow branch exists */
  branchExists: boolean;
  /** Whether .kbot/ directory exists */
  worktreeExists: boolean;
  /** Whether worktree is properly linked to git */
  worktreeLinked: boolean;
  /** Error message if not healthy */
  error?: string;
}

/**
 * Scheduler configuration for batch commits
 *
 * AC-2: Batch interval (5min) OR event threshold (100 events)
 */
export interface KbotSchedulerConfig {
  /** Maximum interval between commits in milliseconds (default: 5 minutes) */
  maxInterval: number;
  /** Maximum events before forcing a commit (default: 100) */
  maxEvents: number;
  /** Whether the scheduler is enabled */
  enabled: boolean;
}

/**
 * Default scheduler configuration
 */
export const DEFAULT_SCHEDULER_CONFIG: KbotSchedulerConfig = {
  maxInterval: 300000, // 5 minutes
  maxEvents: 100,
  enabled: true,
};

/**
 * State of the shadow branch system
 */
export type KbotShadowState =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'committing'
  | 'recovering'
  | 'error';

/**
 * Options for KbotShadow constructor
 */
export interface KbotShadowOptions {
  /** Project root directory (defaults to cwd) */
  projectRoot?: string;
  /** Custom worktree directory name (defaults to .kbot) */
  worktreeDir?: string;
  /** Custom branch name (defaults to kbot-memory) */
  branchName?: string;
  /** Scheduler configuration */
  scheduler?: Partial<KbotSchedulerConfig>;
  /** Enable debug logging */
  debug?: boolean;
}

/**
 * Result from shadow initialization
 */
export interface KbotShadowInitResult {
  /** Whether initialization succeeded */
  success: boolean;
  /** Whether the branch was created */
  branchCreated: boolean;
  /** Whether the worktree was created */
  worktreeCreated: boolean;
  /** Whether .gitignore was updated */
  gitignoreUpdated: boolean;
  /** Whether an initial commit was made */
  initialCommit: boolean;
  /** Whether shadow already existed */
  alreadyExists: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Events emitted by the shadow system
 *
 * AC-4: Emits structured events (sync_start, sync_complete, sync_error)
 */
export interface KbotShadowEvents {
  /** Emitted when a sync operation starts */
  sync_start: { operation: 'commit' | 'init' | 'repair' | 'recover' };
  /** Emitted when a sync operation completes successfully */
  sync_complete: { operation: string; filesChanged: number };
  /** Emitted when a sync operation fails */
  sync_error: { operation: string; error: Error };
  /** Emitted when state changes */
  state_change: { from: KbotShadowState; to: KbotShadowState };
}
