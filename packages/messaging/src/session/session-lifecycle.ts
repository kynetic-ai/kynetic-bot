/**
 * SessionLifecycleManager - Manage ACP session lifecycle per conversation
 *
 * Handles session reuse, rotation on context limit, and recovery after restart.
 * Integrates with ContextUsageTracker for usage monitoring.
 *
 * @see @mem-session-lifecycle
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '@kynetic-bot/core';
import type { ContextUsageUpdate } from '../context/context-usage-tracker.js';

const log = createLogger('session-lifecycle');

// ============================================================================
// Types
// ============================================================================

/**
 * State for an active session
 */
export interface SessionState {
  /** ACP session ID (transient, created per spawn) */
  acpSessionId: string;
  /** Session key for routing (platform:kind:identifier) */
  sessionKey: string;
  /** Associated conversation ID in ConversationStore */
  conversationId: string;
  /** When this session was created */
  createdAt: Date;
  /** Last known context usage */
  lastUsage?: ContextUsageUpdate;
}

/**
 * Result from getOrCreateSession
 */
export interface GetSessionResult {
  /** Session state */
  state: SessionState;
  /** Whether this is a new session (requiring context restoration) */
  isNew: boolean;
  /** Whether session was rotated (previous exceeded threshold) */
  wasRotated: boolean;
  /** Whether session was recovered from a recent conversation after restart */
  wasRecovered: boolean;
}

/**
 * Minimal ACP client interface for session creation
 */
export interface SessionACPClient {
  newSession(params: { cwd: string; mcpServers: unknown[] }): Promise<string>;
}

/**
 * Minimal ConversationStore interface for recovery
 */
export interface SessionConversationStore {
  getConversationBySessionKey(sessionKey: string): Promise<{
    id: string;
    updated_at: string;
  } | null>;
}

/**
 * Minimal SessionStore interface for marking sessions complete
 */
export interface SessionMemoryStore {
  completeSession(sessionId: string): Promise<void>;
  createSession(params: {
    id: string;
    agent_type: string;
    conversation_id: string;
    session_key: string;
  }): Promise<void>;
}

/**
 * Options for SessionLifecycleManager
 */
export interface SessionLifecycleManagerOptions {
  /** Context usage threshold for rotation (default: 0.70 = 70%) */
  rotationThreshold?: number;
  /** Maximum age for "recent" conversations in recovery (default: 30 minutes) */
  recentConversationMaxAgeMs?: number;
}

/**
 * Events emitted by SessionLifecycleManager
 */
export interface SessionLifecycleEvents {
  'session:created': { sessionKey: string; state: SessionState };
  'session:rotated': { sessionKey: string; oldSessionId: string; newState: SessionState };
  'session:recovered': { sessionKey: string; state: SessionState; fromConversationId: string };
  'session:ended': { sessionKey: string; sessionId: string };
  'usage:updated': { sessionKey: string; usage: ContextUsageUpdate };
}

// ============================================================================
// Constants
// ============================================================================

/** Default rotation threshold: 70% context usage */
const DEFAULT_ROTATION_THRESHOLD = 0.7;

/** Default max age for recent conversations: 30 minutes */
const DEFAULT_RECENT_MAX_AGE_MS = 30 * 60 * 1000;

// ============================================================================
// Deferred Helper
// ============================================================================

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ============================================================================
// SessionLifecycleManager Implementation
// ============================================================================

/**
 * Manages ACP session lifecycle per conversation.
 *
 * AC: @mem-session-lifecycle ac-1 - Reuses existing session within threshold
 * AC: @mem-session-lifecycle ac-2 - Rotates session when threshold exceeded
 * AC: @mem-session-lifecycle ac-3 - Creates session with context restoration on restart
 * AC: @mem-session-lifecycle ac-4 - Marks previous session completed on rotation
 * AC: @mem-session-lifecycle ac-5 - Usage tracked via ContextUsageTracker integration
 * AC: @mem-session-lifecycle ac-6 - Receives ContextUsageUpdate from tracker
 * AC: @mem-session-lifecycle ac-7 - Continues with stale data on usage errors
 * AC: @mem-session-lifecycle ac-8 - Per-key locking for message serialization
 * AC: @mem-session-lifecycle ac-9 - Recovery from recent conversations on restart
 *
 * @trait-observable - Emits events for session lifecycle changes
 * @trait-recoverable - Recovers from restart using ConversationStore
 */
export class SessionLifecycleManager extends EventEmitter {
  private readonly rotationThreshold: number;
  private readonly recentMaxAgeMs: number;

  /** In-memory session state: sessionKey -> SessionState */
  private readonly sessions = new Map<string, SessionState>();

  /** Per-key locks for message serialization */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: SessionLifecycleManagerOptions = {}) {
    super();
    this.rotationThreshold = options.rotationThreshold ?? DEFAULT_ROTATION_THRESHOLD;
    this.recentMaxAgeMs = options.recentConversationMaxAgeMs ?? DEFAULT_RECENT_MAX_AGE_MS;
  }

  /**
   * Get or create a session for a session key
   *
   * AC: @mem-session-lifecycle ac-1 - Reuses session if within threshold
   * AC: @mem-session-lifecycle ac-2 - Rotates if threshold exceeded
   * AC: @mem-session-lifecycle ac-3 - Creates new session on restart with context restoration
   * AC: @mem-session-lifecycle ac-9 - Checks for recent conversation on restart
   *
   * @param sessionKey - Routing key (platform:kind:identifier)
   * @param client - ACP client for creating new sessions
   * @param conversationStore - For recovery on restart
   * @param sessionStore - For session persistence
   * @returns Session state and metadata
   */
  async getOrCreateSession(
    sessionKey: string,
    client: SessionACPClient,
    conversationStore: SessionConversationStore,
    sessionStore: SessionMemoryStore
  ): Promise<GetSessionResult> {
    // Check for existing in-memory session
    const existing = this.sessions.get(sessionKey);

    if (existing) {
      // AC-1: Check if within threshold
      if (!this.shouldRotateSession(sessionKey)) {
        log.debug('Reusing existing session', {
          sessionKey,
          acpSessionId: existing.acpSessionId,
        });
        return { state: existing, isNew: false, wasRotated: false, wasRecovered: false };
      }

      // AC-2: Threshold exceeded, rotate
      log.info('Session context threshold exceeded, rotating', {
        sessionKey,
        threshold: this.rotationThreshold,
        currentUsage: existing.lastUsage?.tokens.percentage,
      });

      const newState = await this.rotateSession(
        sessionKey,
        client,
        existing.conversationId,
        sessionStore
      );

      return { state: newState, isNew: true, wasRotated: true, wasRecovered: false };
    }

    // No in-memory session - check for recovery
    // AC-3, AC-9: Check ConversationStore for recent conversation
    const conversation = await conversationStore.getConversationBySessionKey(sessionKey);

    let conversationId: string;
    let isRecovery = false;

    if (conversation) {
      const updatedAt = new Date(conversation.updated_at);
      const age = Date.now() - updatedAt.getTime();

      if (age < this.recentMaxAgeMs) {
        // Recent conversation - this is a recovery scenario
        log.info('Recovering from recent conversation', {
          sessionKey,
          conversationId: conversation.id,
          ageMs: age,
        });
        conversationId = conversation.id;
        isRecovery = true;
      } else {
        // Stale conversation - still use it but not "recovery"
        conversationId = conversation.id;
      }
    } else {
      // No existing conversation - caller should create one
      // For now, use a placeholder that caller must replace
      conversationId = '';
    }

    // Create new ACP session
    const acpSessionId = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    const state: SessionState = {
      acpSessionId,
      sessionKey,
      conversationId,
      createdAt: new Date(),
    };

    this.sessions.set(sessionKey, state);

    // Persist session if we have a conversation
    if (conversationId) {
      await sessionStore.createSession({
        id: acpSessionId,
        agent_type: 'claude',
        conversation_id: conversationId,
        session_key: sessionKey,
      });
    }

    // Emit appropriate event
    if (isRecovery) {
      this.emit('session:recovered', {
        sessionKey,
        state,
        fromConversationId: conversationId,
      });
    } else {
      this.emit('session:created', { sessionKey, state });
    }

    return { state, isNew: true, wasRotated: false, wasRecovered: isRecovery };
  }

  /**
   * Check if a session should be rotated based on context usage
   *
   * AC: @mem-session-lifecycle ac-1 - Returns false if under threshold
   * AC: @mem-session-lifecycle ac-2 - Returns true if at or above threshold
   *
   * @param sessionKey - Session key to check
   * @returns true if session should be rotated
   */
  shouldRotateSession(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session?.lastUsage) {
      return false;
    }

    const usage = session.lastUsage.tokens.percentage / 100;
    return usage >= this.rotationThreshold;
  }

  /**
   * Rotate a session - create new session and mark old one complete
   *
   * AC: @mem-session-lifecycle ac-2 - Creates new session
   * AC: @mem-session-lifecycle ac-4 - Marks previous session completed
   *
   * @param sessionKey - Session key to rotate
   * @param client - ACP client for creating new session
   * @param conversationId - Conversation ID to associate
   * @param sessionStore - For marking old session complete
   * @returns New session state
   */
  async rotateSession(
    sessionKey: string,
    client: SessionACPClient,
    conversationId: string,
    sessionStore: SessionMemoryStore
  ): Promise<SessionState> {
    const existing = this.sessions.get(sessionKey);
    const oldSessionId = existing?.acpSessionId;

    // Create new ACP session
    const acpSessionId = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    const newState: SessionState = {
      acpSessionId,
      sessionKey,
      conversationId,
      createdAt: new Date(),
    };

    // Update in-memory state
    this.sessions.set(sessionKey, newState);

    // Persist new session
    await sessionStore.createSession({
      id: acpSessionId,
      agent_type: 'claude',
      conversation_id: conversationId,
      session_key: sessionKey,
    });

    // AC-4: Mark old session as complete
    if (oldSessionId) {
      try {
        await sessionStore.completeSession(oldSessionId);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.warn('Failed to mark old session complete', {
          sessionId: oldSessionId,
          error: error.message,
        });
      }

      this.emit('session:rotated', {
        sessionKey,
        oldSessionId,
        newState,
      });
    }

    return newState;
  }

  /**
   * Update context usage for a session
   *
   * AC: @mem-session-lifecycle ac-6 - Receives ContextUsageUpdate
   *
   * @param sessionKey - Session key to update
   * @param usage - Context usage data
   */
  updateContextUsage(sessionKey: string, usage: ContextUsageUpdate): void {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      log.warn('Cannot update usage for unknown session', { sessionKey });
      return;
    }

    session.lastUsage = usage;
    this.emit('usage:updated', { sessionKey, usage });

    log.debug('Context usage updated', {
      sessionKey,
      current: usage.tokens.current,
      max: usage.tokens.max,
      percentage: usage.tokens.percentage,
    });
  }

  /**
   * Execute a function with per-key locking
   *
   * AC: @mem-session-lifecycle ac-8 - Messages serialized via per-key lock
   *
   * @param sessionKey - Session key to lock on
   * @param fn - Function to execute while holding lock
   * @returns Result from the function
   */
  async withLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing lock
    const existing = this.locks.get(sessionKey) ?? Promise.resolve();

    // Create a deferred for our lock release
    const release = createDeferred<void>();

    // Set our lock (chained to existing)
    this.locks.set(
      sessionKey,
      existing.then(() => release.promise)
    );

    // Wait for existing lock to complete
    await existing;

    try {
      return await fn();
    } finally {
      release.resolve();
    }
  }

  /**
   * End a session
   *
   * @param sessionKey - Session key to end
   */
  endSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }

    this.sessions.delete(sessionKey);
    this.emit('session:ended', {
      sessionKey,
      sessionId: session.acpSessionId,
    });

    log.debug('Session ended', { sessionKey, acpSessionId: session.acpSessionId });
  }

  /**
   * Get session state for a session key
   *
   * @param sessionKey - Session key to look up
   * @returns Session state or undefined
   */
  getSession(sessionKey: string): SessionState | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * Get all active sessions
   *
   * @returns Array of session states
   */
  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Update the conversation ID for a session
   *
   * Called after creating a new conversation for a session that didn't have one.
   *
   * @param sessionKey - Session key to update
   * @param conversationId - New conversation ID
   */
  setConversationId(sessionKey: string, conversationId: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.conversationId = conversationId;
    }
  }

  /**
   * Clear all sessions (for testing)
   */
  clear(): void {
    this.sessions.clear();
    this.locks.clear();
  }
}
