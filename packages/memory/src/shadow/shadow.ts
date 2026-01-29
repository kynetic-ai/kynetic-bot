/**
 * KbotShadow - Main Shadow Branch Orchestration Class
 *
 * Manages shadow branch lifecycle, scheduling, and events.
 * Uses composition for EventEmitter pattern.
 */

import { EventEmitter } from 'node:events';
import type {
  KbotSchedulerConfig,
  KbotShadowConfig,
  KbotShadowEvents,
  KbotShadowOptions,
  KbotShadowState,
  KbotShadowStatus,
} from './config.js';
import { DEFAULT_SCHEDULER_CONFIG, KBOT_BRANCH_NAME, KBOT_WORKTREE_DIR } from './config.js';
import { hasLockFile, kbotAutoCommit, recoverFromCrash } from './commit.js';
import { detectKbotShadow, getKbotShadowStatus } from './detect.js';
import { createKbotShadowError, initializeKbotShadow, repairKbotShadow } from './init.js';
import { KbotShadowError } from './errors.js';

/**
 * Type-safe event emitter for shadow events
 */
class ShadowEventEmitter {
  private emitter = new EventEmitter();

  on<K extends keyof KbotShadowEvents>(
    event: K,
    listener: (payload: KbotShadowEvents[K]) => void,
  ): this {
    this.emitter.on(event as string, listener);
    return this;
  }

  off<K extends keyof KbotShadowEvents>(
    event: K,
    listener: (payload: KbotShadowEvents[K]) => void,
  ): this {
    this.emitter.off(event as string, listener);
    return this;
  }

  once<K extends keyof KbotShadowEvents>(
    event: K,
    listener: (payload: KbotShadowEvents[K]) => void,
  ): this {
    this.emitter.once(event as string, listener);
    return this;
  }

  emit<K extends keyof KbotShadowEvents>(event: K, payload: KbotShadowEvents[K]): boolean {
    return this.emitter.emit(event as string, payload);
  }

  removeAllListeners<K extends keyof KbotShadowEvents>(event?: K): this {
    this.emitter.removeAllListeners(event as string);
    return this;
  }
}

/**
 * KbotShadow - Shadow branch orchestration
 *
 * Manages:
 * - Auto-initialization on first access
 * - Batch commit scheduling
 * - Crash recovery
 * - Event emission for sync operations
 */
export class KbotShadow {
  private projectRoot: string;
  private worktreeDirName: string;
  private branchName: string;
  private schedulerConfig: KbotSchedulerConfig;
  private debug: boolean;

  private config: KbotShadowConfig | null = null;
  private state: KbotShadowState = 'uninitialized';
  private eventCount = 0;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private events = new ShadowEventEmitter();

  constructor(options: KbotShadowOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.worktreeDirName = options.worktreeDir ?? KBOT_WORKTREE_DIR;
    this.branchName = options.branchName ?? KBOT_BRANCH_NAME;
    this.schedulerConfig = {
      ...DEFAULT_SCHEDULER_CONFIG,
      ...options.scheduler,
    };
    this.debug = options.debug ?? false;
  }

  // ==================== Event Methods (Composition) ====================

  /**
   * Register an event listener
   * AC-4: Observable - all operations emit events
   */
  on<K extends keyof KbotShadowEvents>(
    event: K,
    listener: (payload: KbotShadowEvents[K]) => void,
  ): this {
    this.events.on(event, listener);
    return this;
  }

  /**
   * Remove an event listener
   */
  off<K extends keyof KbotShadowEvents>(
    event: K,
    listener: (payload: KbotShadowEvents[K]) => void,
  ): this {
    this.events.off(event, listener);
    return this;
  }

  /**
   * Register a one-time event listener
   */
  once<K extends keyof KbotShadowEvents>(
    event: K,
    listener: (payload: KbotShadowEvents[K]) => void,
  ): this {
    this.events.once(event, listener);
    return this;
  }

  // ==================== State Management ====================

  /**
   * Transition to a new state
   */
  private setState(newState: KbotShadowState): void {
    if (this.state !== newState) {
      const from = this.state;
      this.state = newState;
      this.events.emit('state_change', { from, to: newState });
    }
  }

  /**
   * Get current state
   */
  getState(): KbotShadowState {
    return this.state;
  }

  /**
   * Get current configuration (null if not initialized)
   */
  getConfig(): KbotShadowConfig | null {
    return this.config;
  }

  /**
   * Get detailed status
   */
  async getStatus(): Promise<KbotShadowStatus> {
    return getKbotShadowStatus(this.projectRoot, {
      worktreeDir: this.worktreeDirName,
      branchName: this.branchName,
    });
  }

  // ==================== Lifecycle ====================

  /**
   * Initialize the shadow branch system.
   * Auto-creates if missing, runs recovery if needed.
   *
   * AC-3: Auto-init on access
   * AC-6: Runs crash recovery
   */
  async initialize(): Promise<void> {
    if (this.state === 'ready') {
      return; // Already initialized
    }

    if (this.state === 'initializing') {
      // Wait for ongoing initialization
      return new Promise((resolve, reject) => {
        const handler = (payload: { from: KbotShadowState; to: KbotShadowState }) => {
          if (payload.to === 'ready') {
            this.off('state_change', handler);
            resolve();
          } else if (payload.to === 'error') {
            this.off('state_change', handler);
            reject(new KbotShadowError(
              'Initialization failed',
              'NOT_INITIALIZED',
              'Check logs for details.',
            ));
          }
        };
        this.on('state_change', handler);
      });
    }

    this.setState('initializing');
    this.events.emit('sync_start', { operation: 'init' });

    try {
      // Try to detect existing shadow
      this.config = await detectKbotShadow(this.projectRoot, {
        worktreeDir: this.worktreeDirName,
        branchName: this.branchName,
      });

      if (!this.config) {
        // Auto-initialize
        const initResult = await initializeKbotShadow(this.projectRoot, {
          worktreeDir: this.worktreeDirName,
          branchName: this.branchName,
          debug: this.debug,
        });

        if (!initResult.success) {
          throw new KbotShadowError(
            initResult.error || 'Failed to initialize shadow branch',
            'NOT_INITIALIZED',
            'Check git status and permissions.',
          );
        }

        // Re-detect after init
        this.config = await detectKbotShadow(this.projectRoot, {
          worktreeDir: this.worktreeDirName,
          branchName: this.branchName,
        });

        if (!this.config) {
          throw new KbotShadowError(
            'Shadow branch created but not detected',
            'NOT_INITIALIZED',
            'This should not happen - check git worktree status.',
          );
        }
      }

      // Check for crash recovery
      if (await hasLockFile(this.config.worktreeDir)) {
        this.setState('recovering');
        this.events.emit('sync_start', { operation: 'recover' });

        const recoveryResult = await recoverFromCrash(this.config.worktreeDir, this.debug);

        if (recoveryResult.error) {
          this.events.emit('sync_error', {
            operation: 'recover',
            error: recoveryResult.error,
          });
          // Continue anyway - recovery is best-effort
        } else {
          this.events.emit('sync_complete', {
            operation: 'recover',
            filesChanged: recoveryResult.filesChanged,
          });
        }
      }

      // Start scheduler
      this.startScheduler();

      this.setState('ready');
      this.events.emit('sync_complete', { operation: 'init', filesChanged: 0 });
    } catch (error) {
      this.setState('error');
      const err = error instanceof Error ? error : new Error(String(error));
      this.events.emit('sync_error', { operation: 'init', error: err });
      throw error;
    }
  }

  /**
   * Shutdown the shadow system.
   * Commits pending changes and stops scheduler.
   */
  async shutdown(): Promise<void> {
    // Stop scheduler
    this.stopScheduler();

    // Commit any pending changes
    if (this.config && this.eventCount > 0) {
      await this.forceCommit('Shutdown: commit pending changes');
    }

    this.setState('uninitialized');
    this.config = null;
    this.eventCount = 0;
  }

  // ==================== Scheduler ====================

  /**
   * Start the batch commit scheduler
   *
   * AC-2: Batch interval (5min) OR event threshold (100 events)
   */
  private startScheduler(): void {
    if (!this.schedulerConfig.enabled) {
      return;
    }

    this.schedulerTimer = setInterval(() => {
      this.schedulerTick().catch((error) => {
        this.events.emit('sync_error', {
          operation: 'scheduled_commit',
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    }, this.schedulerConfig.maxInterval);

    // Don't keep the Node.js process alive just for this timer
    this.schedulerTimer.unref();
  }

  /**
   * Stop the scheduler
   */
  private stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  /**
   * Scheduler tick - commit if events pending
   */
  private async schedulerTick(): Promise<void> {
    if (this.eventCount > 0) {
      await this.forceCommit(`Batch commit: ${this.eventCount} events`);
    }
  }

  /**
   * Check if event threshold reached and commit if needed
   */
  private async checkEventThreshold(): Promise<void> {
    if (this.eventCount >= this.schedulerConfig.maxEvents) {
      await this.forceCommit(`Event threshold: ${this.eventCount} events`);
    }
  }

  // ==================== Operations ====================

  /**
   * Record an event (triggers scheduler evaluation)
   *
   * @param operation Type of operation
   * @param ref Optional reference
   */
  recordEvent(operation: string, ref?: string): void {
    this.eventCount++;

    if (this.debug) {
      console.error(`[KBOT DEBUG] Event recorded: ${operation}${ref ? ` (${ref})` : ''}`);
    }

    // Check threshold asynchronously with error handling
    this.checkEventThreshold().catch((error) => {
      this.events.emit('sync_error', {
        operation: 'threshold_commit',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
  }

  /**
   * Force an immediate commit
   *
   * @param message Optional commit message
   * @returns true if commit was made
   */
  async forceCommit(message?: string): Promise<boolean> {
    if (!this.config) {
      return false;
    }

    if (this.state === 'committing') {
      return false; // Already committing
    }

    this.setState('committing');
    this.events.emit('sync_start', { operation: 'commit' });

    try {
      const result = await kbotAutoCommit(
        this.config.worktreeDir,
        message || `Memory update: ${this.eventCount} events`,
        this.debug,
      );

      if (result.error) {
        this.events.emit('sync_error', { operation: 'commit', error: result.error });
        return false;
      }

      this.events.emit('sync_complete', {
        operation: 'commit',
        filesChanged: result.filesChanged,
      });

      // Reset event counter
      this.eventCount = 0;

      return result.committed;
    } finally {
      this.setState('ready');
    }
  }

  /**
   * Repair the shadow branch
   */
  async repair(): Promise<void> {
    this.events.emit('sync_start', { operation: 'repair' });

    try {
      const result = await repairKbotShadow(this.projectRoot, {
        worktreeDir: this.worktreeDirName,
        branchName: this.branchName,
      });

      if (!result.success) {
        throw new KbotShadowError(
          result.error || 'Failed to repair shadow branch',
          'GIT_ERROR',
          'Check git status and try manual repair.',
        );
      }

      // Re-detect
      this.config = await detectKbotShadow(this.projectRoot, {
        worktreeDir: this.worktreeDirName,
        branchName: this.branchName,
      });

      this.events.emit('sync_complete', { operation: 'repair', filesChanged: 0 });
      this.setState('ready');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.events.emit('sync_error', { operation: 'repair', error: err });
      this.setState('error');
      throw error;
    }
  }

  /**
   * Get the worktree directory path
   */
  getWorktreeDir(): string | null {
    return this.config?.worktreeDir ?? null;
  }

  /**
   * Check if shadow is ready
   */
  isReady(): boolean {
    return this.state === 'ready' && this.config !== null;
  }

  /**
   * Require shadow to be ready, throw if not
   */
  async requireReady(): Promise<KbotShadowConfig> {
    if (!this.isReady()) {
      await this.initialize();
    }

    if (!this.config) {
      const status = await this.getStatus();
      throw createKbotShadowError(status);
    }

    return this.config;
  }
}
