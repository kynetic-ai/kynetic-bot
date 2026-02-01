/**
 * ThreadTracker - Manages Discord thread lifecycle for tool widget isolation
 *
 * Handles:
 * - Thread creation for guild channel tool calls
 * - Race condition prevention via promise deduplication
 * - Session cleanup
 * - Per-response thread isolation
 *
 * @see @discord-tool-widgets ac-10, ac-11, ac-13, ac-16, ac-17
 */

import { createLogger, type Logger } from '@kynetic-bot/core';

/**
 * Thread state for a parent message
 */
export interface ThreadState {
  /** Bot's response message (thread parent) */
  parentMessageId: string;
  /** Discord thread ID (null until created) */
  threadId: string | null;
  /** Main channel ID */
  channelId: string;
  /** Session for cleanup */
  sessionId: string;
  /** Creation timestamp */
  createdAt: Date;
}

/**
 * ThreadTracker - Tracks threads created for tool widget isolation
 *
 * Each response message gets its own thread (per-response isolation).
 * Uses promise deduplication to prevent race conditions when multiple
 * tool_calls arrive before thread creation completes.
 */
export class ThreadTracker {
  private readonly logger: Logger;

  /**
   * Map from composite key (sessionId:channelId:parentMessageId) to ThreadState
   */
  private readonly threadStates = new Map<string, ThreadState>();

  /**
   * Map from composite key to pending thread creation promise
   * Used for race condition prevention - multiple tool_calls can arrive
   * before the thread is created, and we want them all to use the same thread.
   */
  private readonly pendingCreations = new Map<string, Promise<string | null>>();

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger('thread-tracker');
  }

  /**
   * Get existing thread or create a new one
   *
   * Race-safe via promise deduplication - if multiple calls arrive while
   * thread is being created, they all wait for the same promise.
   *
   * AC: @discord-tool-widgets ac-10 - Thread creation on first tool_call
   * AC: @discord-tool-widgets ac-11 - Reuse existing thread
   * AC: @discord-tool-widgets ac-16 - Per-response thread isolation
   *
   * @param sessionId - Session ID for tracking
   * @param channelId - Discord channel ID
   * @param parentMessageId - Bot's response message to attach thread to
   * @param createFn - Function to create the thread (returns thread ID)
   * @returns Thread ID or null if creation failed
   */
  async getOrCreateThread(
    sessionId: string,
    channelId: string,
    parentMessageId: string,
    createFn: () => Promise<string>
  ): Promise<string | null> {
    const key = this.buildKey(sessionId, channelId, parentMessageId);

    // Check for existing thread state
    const existingState = this.threadStates.get(key);
    if (existingState) {
      // Thread exists or creation was already attempted
      if (existingState.threadId) {
        this.logger.debug('Using existing thread', {
          sessionId,
          channelId,
          parentMessageId,
          threadId: existingState.threadId,
        });
        return existingState.threadId;
      } else {
        // Creation was attempted but failed (or thread was deleted)
        // Return null to trigger fallback behavior
        this.logger.debug('Thread state exists but no threadId (failed/deleted)', {
          sessionId,
          channelId,
          parentMessageId,
        });
        return null;
      }
    }

    // Check for pending creation (race condition prevention)
    const pendingPromise = this.pendingCreations.get(key);
    if (pendingPromise) {
      this.logger.debug('Waiting for pending thread creation', {
        sessionId,
        channelId,
        parentMessageId,
      });
      return pendingPromise;
    }

    // Create new thread
    this.logger.debug('Creating new thread', {
      sessionId,
      channelId,
      parentMessageId,
    });

    const creationPromise = this.createThread(key, sessionId, channelId, parentMessageId, createFn);
    this.pendingCreations.set(key, creationPromise);

    try {
      const threadId = await creationPromise;
      return threadId;
    } finally {
      // Clean up pending promise regardless of success/failure
      this.pendingCreations.delete(key);
    }
  }

  /**
   * Internal thread creation with state management
   */
  private async createThread(
    key: string,
    sessionId: string,
    channelId: string,
    parentMessageId: string,
    createFn: () => Promise<string>
  ): Promise<string | null> {
    try {
      const threadId = await createFn();

      // Store thread state
      this.threadStates.set(key, {
        parentMessageId,
        threadId,
        channelId,
        sessionId,
        createdAt: new Date(),
      });

      this.logger.info('Thread created', {
        sessionId,
        channelId,
        parentMessageId,
        threadId,
      });

      return threadId;
    } catch (error) {
      // AC: @discord-tool-widgets ac-12, ac-17 - Graceful failure
      this.logger.warn('Thread creation failed', {
        sessionId,
        channelId,
        parentMessageId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Store state with null threadId to indicate failure
      // This prevents repeated creation attempts for the same message
      this.threadStates.set(key, {
        parentMessageId,
        threadId: null,
        channelId,
        sessionId,
        createdAt: new Date(),
      });

      return null;
    }
  }

  /**
   * Get thread ID if it exists (for sending updates)
   *
   * @param sessionId - Session ID
   * @param channelId - Discord channel ID
   * @param parentMessageId - Bot's response message ID
   * @returns Thread ID or null if not exists/failed
   */
  getThreadId(sessionId: string, channelId: string, parentMessageId: string): string | null {
    const key = this.buildKey(sessionId, channelId, parentMessageId);
    return this.threadStates.get(key)?.threadId ?? null;
  }

  /**
   * Check if a thread exists for the given parent message
   *
   * @param sessionId - Session ID
   * @param channelId - Discord channel ID
   * @param parentMessageId - Bot's response message ID
   * @returns True if thread exists (even if creation failed)
   */
  hasThread(sessionId: string, channelId: string, parentMessageId: string): boolean {
    const key = this.buildKey(sessionId, channelId, parentMessageId);
    return this.threadStates.has(key);
  }

  /**
   * Mark a thread as deleted (for fallback handling)
   *
   * AC: @discord-tool-widgets ac-17 - Handle deleted thread
   *
   * @param sessionId - Session ID
   * @param channelId - Discord channel ID
   * @param parentMessageId - Bot's response message ID
   */
  markThreadDeleted(sessionId: string, channelId: string, parentMessageId: string): void {
    const key = this.buildKey(sessionId, channelId, parentMessageId);
    const state = this.threadStates.get(key);

    if (state) {
      this.logger.warn('Thread marked as deleted', {
        sessionId,
        channelId,
        parentMessageId,
        threadId: state.threadId,
      });

      // Set threadId to null to indicate thread is no longer available
      state.threadId = null;
    }
  }

  /**
   * Clean up tracking for a session
   *
   * AC: @discord-tool-widgets ac-13 - Session cleanup
   *
   * @param sessionId - Session ID to clean up
   */
  cleanupSession(sessionId: string): void {
    const keysToDelete: string[] = [];

    for (const [key, state] of this.threadStates.entries()) {
      if (state.sessionId === sessionId) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.threadStates.delete(key);
      // Also clean up any pending creations (shouldn't happen in normal flow)
      this.pendingCreations.delete(key);
    }

    this.logger.debug('Session cleanup complete', {
      sessionId,
      threadsRemoved: keysToDelete.length,
    });
  }

  /**
   * Get all thread states (for debugging/testing)
   */
  getAllThreadStates(): ThreadState[] {
    return Array.from(this.threadStates.values());
  }

  /**
   * Get thread states for a specific session (for debugging/testing)
   */
  getSessionThreads(sessionId: string): ThreadState[] {
    return Array.from(this.threadStates.values()).filter((state) => state.sessionId === sessionId);
  }

  /**
   * Build composite key for thread lookup
   */
  private buildKey(sessionId: string, channelId: string, parentMessageId: string): string {
    return `${sessionId}:${channelId}:${parentMessageId}`;
  }
}
