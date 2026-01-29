/**
 * SessionStore - Persistent session and event storage
 *
 * Manages agent sessions with YAML metadata and JSONL event logs.
 * Provides crash-safe atomic writes and recovery capabilities.
 *
 * @see @mem-agent-sessions
 */

import * as fs from 'node:fs/promises';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { ulid } from 'ulid';
import { EventEmitter } from 'node:events';
import { ZodError } from 'zod';

import {
  AgentSessionMetadata,
  AgentSessionMetadataSchema,
  AgentSessionStatus,
  SessionEvent,
  SessionEventInputSchema,
  SessionMetadataInput,
  SessionMetadataInputSchema,
  type SessionEventInput,
} from '../types/session.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a SessionStore
 */
export interface SessionStoreOptions {
  /** Base directory for session storage (e.g., .kbot/) */
  baseDir: string;
  /** Event emitter for observability (optional) */
  emitter?: EventEmitter;
}

/**
 * Options for listing sessions
 */
export interface ListSessionsOptions {
  /** Filter by session status */
  status?: AgentSessionStatus;
  /** Filter by agent type */
  agentType?: string;
  /** Maximum number of sessions to return */
  limit?: number;
}

/**
 * Error thrown when session operations fail
 */
export class SessionStoreError extends Error {
  readonly code: string;
  readonly sessionId?: string;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    sessionId?: string,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SessionStoreError';
    this.code = code;
    this.sessionId = sessionId;
    this.context = context;
  }
}

/**
 * Error thrown when Zod validation fails
 *
 * AC: @mem-agent-sessions ac-6 - Rejects with Zod validation error
 */
export class SessionValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly zodError: ZodError;
  readonly field?: string;

  constructor(message: string, zodError: ZodError, field?: string) {
    super(message);
    this.name = 'SessionValidationError';
    this.zodError = zodError;
    this.field = field;
  }
}

// ============================================================================
// Event Types for Observability
// ============================================================================

/**
 * Events emitted by SessionStore for observability
 *
 * AC: @mem-agent-sessions ac-5 - Emits structured event for observability
 */
export interface SessionStoreEvents {
  'session:created': { session: AgentSessionMetadata };
  'session:updated': { sessionId: string; status: AgentSessionStatus };
  'session:ended': { sessionId: string; status: AgentSessionStatus; endedAt: string };
  'event:appended': { sessionId: string; event: SessionEvent };
  'error': { error: Error; operation: string; sessionId?: string };
}

// ============================================================================
// SessionStore Implementation
// ============================================================================

/**
 * SessionStore manages agent session storage with JSONL event logs.
 *
 * Storage layout:
 * ```
 * {baseDir}/sessions/{session-id}/
 * ├── session.yaml       # SessionMetadata
 * └── events.jsonl       # Append-only event log
 * ```
 *
 * @example
 * ```typescript
 * const store = new SessionStore({ baseDir: '.kbot' });
 *
 * // Create a new session
 * const session = await store.createSession({
 *   id: ulid(),
 *   agent_type: 'claude',
 * });
 *
 * // Append events
 * await store.appendEvent({
 *   type: 'session.start',
 *   session_id: session.id,
 *   data: { trigger: 'user_message' },
 * });
 * ```
 */
export class SessionStore {
  private readonly baseDir: string;
  private readonly sessionsDir: string;
  private readonly emitter?: EventEmitter;

  constructor(options: SessionStoreOptions) {
    this.baseDir = options.baseDir;
    this.sessionsDir = path.join(options.baseDir, 'sessions');
    this.emitter = options.emitter;
  }

  // ==========================================================================
  // Path Helpers
  // ==========================================================================

  /**
   * Get the directory path for a session
   */
  private sessionDir(sessionId: string): string {
    return path.join(this.sessionsDir, sessionId);
  }

  /**
   * Get the path to session.yaml for a session
   */
  private sessionYamlPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'session.yaml');
  }

  /**
   * Get the path to events.jsonl for a session
   */
  private eventsJsonlPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'events.jsonl');
  }

  // ==========================================================================
  // Emit Helper
  // ==========================================================================

  /**
   * Emit an event if emitter is configured
   */
  private emit<K extends keyof SessionStoreEvents>(
    event: K,
    data: SessionStoreEvents[K],
  ): void {
    if (this.emitter) {
      this.emitter.emit(event, data);
    }
  }

  // ==========================================================================
  // Session Operations
  // ==========================================================================

  /**
   * Create a new session with metadata.
   *
   * AC: @mem-agent-sessions ac-1 - Creates session with session.yaml and events.jsonl
   *
   * @param input - Session metadata input (id and agent_type required)
   * @returns Created session metadata
   * @throws SessionValidationError if input validation fails
   */
  async createSession(input: SessionMetadataInput): Promise<AgentSessionMetadata> {
    // Validate input
    const parseResult = SessionMetadataInputSchema.safeParse(input);
    if (!parseResult.success) {
      throw new SessionValidationError(
        `Invalid session input: ${parseResult.error.message}`,
        parseResult.error,
        parseResult.error.issues[0]?.path.join('.'),
      );
    }

    const validInput = parseResult.data;

    // Generate ID if not provided
    const sessionId = validInput.id || ulid();

    // Build full metadata with defaults
    const now = new Date().toISOString();
    const metadata: AgentSessionMetadata = {
      id: sessionId,
      agent_type: validInput.agent_type,
      conversation_id: validInput.conversation_id,
      session_key: validInput.session_key,
      status: validInput.status ?? 'active',
      started_at: validInput.started_at ?? now,
      ended_at: undefined,
    };

    // Validate full metadata
    const fullResult = AgentSessionMetadataSchema.safeParse(metadata);
    if (!fullResult.success) {
      throw new SessionValidationError(
        `Invalid session metadata: ${fullResult.error.message}`,
        fullResult.error,
      );
    }

    // Create session directory
    const dir = this.sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });

    // Write session.yaml
    const yamlContent = yamlStringify(metadata);
    await fs.writeFile(this.sessionYamlPath(sessionId), yamlContent, 'utf-8');

    // Create empty events.jsonl
    await fs.writeFile(this.eventsJsonlPath(sessionId), '', 'utf-8');

    // Emit event
    this.emit('session:created', { session: metadata });

    return metadata;
  }

  /**
   * Get session metadata by ID.
   *
   * @param sessionId - Session ID to look up
   * @returns Session metadata or null if not found
   */
  async getSession(sessionId: string): Promise<AgentSessionMetadata | null> {
    const yamlPath = this.sessionYamlPath(sessionId);

    if (!existsSync(yamlPath)) {
      return null;
    }

    try {
      const content = await fs.readFile(yamlPath, 'utf-8');
      const data = yamlParse(content);

      // Validate loaded data
      const result = AgentSessionMetadataSchema.safeParse(data);
      if (!result.success) {
        this.emit('error', {
          error: new Error(`Corrupted session.yaml: ${result.error.message}`),
          operation: 'getSession',
          sessionId,
        });
        return null;
      }

      return result.data;
    } catch (error) {
      this.emit('error', {
        error: error as Error,
        operation: 'getSession',
        sessionId,
      });
      return null;
    }
  }

  /**
   * Check if a session exists.
   *
   * @param sessionId - Session ID to check
   * @returns True if session exists
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    return existsSync(this.sessionYamlPath(sessionId));
  }

  /**
   * Update session status.
   *
   * AC: @mem-agent-sessions ac-4 - Sets ended_at timestamp and final status
   *
   * @param sessionId - Session ID to update
   * @param status - New status
   * @returns Updated session metadata or null if session not found
   */
  async updateSessionStatus(
    sessionId: string,
    status: AgentSessionStatus,
  ): Promise<AgentSessionMetadata | null> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return null;
    }

    // Update status
    session.status = status;

    // Set ended_at if status is terminal
    if (status === 'completed' || status === 'abandoned') {
      session.ended_at = new Date().toISOString();
      this.emit('session:ended', {
        sessionId,
        status,
        endedAt: session.ended_at,
      });
    } else {
      this.emit('session:updated', { sessionId, status });
    }

    // Write updated session.yaml
    const yamlContent = yamlStringify(session);
    await fs.writeFile(this.sessionYamlPath(sessionId), yamlContent, 'utf-8');

    return session;
  }

  /**
   * List sessions with optional filtering.
   *
   * @param options - Filter options
   * @returns Array of session metadata
   */
  async listSessions(options?: ListSessionsOptions): Promise<AgentSessionMetadata[]> {
    // Ensure sessions directory exists
    if (!existsSync(this.sessionsDir)) {
      return [];
    }

    const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    const sessionDirs = entries.filter((e) => e.isDirectory());

    const sessions: AgentSessionMetadata[] = [];

    for (const dir of sessionDirs) {
      const session = await this.getSession(dir.name);
      if (!session) continue;

      // Apply filters
      if (options?.status && session.status !== options.status) continue;
      if (options?.agentType && session.agent_type !== options.agentType) continue;

      sessions.push(session);

      // Apply limit
      if (options?.limit && sessions.length >= options.limit) break;
    }

    // Sort by started_at descending (most recent first)
    sessions.sort((a, b) => b.started_at.localeCompare(a.started_at));

    return sessions;
  }

  /**
   * Find and mark orphaned sessions as abandoned.
   *
   * AC: @mem-agent-sessions ac-7 - Marks orphaned sessions as abandoned
   *
   * @returns Number of sessions marked as abandoned
   */
  async recoverOrphanedSessions(): Promise<number> {
    const activeSessions = await this.listSessions({ status: 'active' });
    let recovered = 0;

    for (const session of activeSessions) {
      // Mark as abandoned
      await this.updateSessionStatus(session.id, 'abandoned');
      recovered++;
    }

    return recovered;
  }

  // ==========================================================================
  // Event Operations
  // ==========================================================================

  /**
   * Append an event to a session's event log.
   *
   * AC: @mem-agent-sessions ac-2 - Appends events with auto-assigned ts and seq
   * AC: @mem-agent-sessions ac-3 - Supports tool.call and tool.result events
   * AC: @mem-agent-sessions ac-5 - Emits structured event for observability
   * AC: @mem-agent-sessions ac-6 - Rejects with Zod validation error
   *
   * @param input - Event input (type, session_id, and data required)
   * @returns Created event with ts and seq assigned
   * @throws SessionStoreError if session not found
   * @throws SessionValidationError if input validation fails
   */
  async appendEvent(input: SessionEventInput): Promise<SessionEvent> {
    // Validate input
    const parseResult = SessionEventInputSchema.safeParse(input);
    if (!parseResult.success) {
      throw new SessionValidationError(
        `Invalid event input: ${parseResult.error.message}`,
        parseResult.error,
        parseResult.error.issues[0]?.path.join('.'),
      );
    }

    const validInput = parseResult.data;
    const sessionId = validInput.session_id;

    // Check session exists
    if (!existsSync(this.sessionDir(sessionId))) {
      throw new SessionStoreError(
        `Session not found: ${sessionId}`,
        'SESSION_NOT_FOUND',
        sessionId,
      );
    }

    // Get current event count for seq assignment
    const eventsPath = this.eventsJsonlPath(sessionId);
    let seq = 0;

    if (existsSync(eventsPath)) {
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());
      seq = lines.length;
    }

    // Build full event with auto-assigned fields
    const event: SessionEvent = {
      ts: validInput.ts ?? Date.now(),
      seq: validInput.seq ?? seq,
      type: validInput.type,
      session_id: sessionId,
      trace_id: validInput.trace_id,
      data: validInput.data,
    };

    // Atomic append using sync write
    const line = JSON.stringify(event) + '\n';
    appendFileSync(eventsPath, line, 'utf-8');

    // Emit event
    this.emit('event:appended', { sessionId, event });

    return event;
  }

  /**
   * Read all events for a session.
   *
   * Skips invalid JSON lines with a warning (for crash recovery).
   *
   * @param sessionId - Session ID to read events for
   * @returns Array of events sorted by seq
   */
  async readEvents(sessionId: string): Promise<SessionEvent[]> {
    const eventsPath = this.eventsJsonlPath(sessionId);

    if (!existsSync(eventsPath)) {
      return [];
    }

    const content = await fs.readFile(eventsPath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    const events: SessionEvent[] = [];
    let skipped = 0;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        events.push(parsed as SessionEvent);
      } catch {
        skipped++;
        this.emit('error', {
          error: new Error(`Invalid JSON line skipped in events.jsonl`),
          operation: 'readEvents',
          sessionId,
        });
      }
    }

    if (skipped > 0) {
      // Log warning about skipped lines (AC trait-recoverable)
      this.emit('error', {
        error: new Error(`Skipped ${skipped} invalid JSON lines`),
        operation: 'readEvents',
        sessionId,
      });
    }

    // Sort by seq
    events.sort((a, b) => a.seq - b.seq);

    return events;
  }

  /**
   * Read events within a time range.
   *
   * @param sessionId - Session ID to read events for
   * @param since - Start timestamp (inclusive)
   * @param until - End timestamp (inclusive, optional)
   * @returns Array of events in range
   */
  async readEventsSince(
    sessionId: string,
    since: number,
    until?: number,
  ): Promise<SessionEvent[]> {
    const events = await this.readEvents(sessionId);

    return events.filter((event) => {
      if (event.ts < since) return false;
      if (until !== undefined && event.ts > until) return false;
      return true;
    });
  }

  /**
   * Get the last event for a session.
   *
   * @param sessionId - Session ID to get last event for
   * @returns Last event or null if no events
   */
  async getLastEvent(sessionId: string): Promise<SessionEvent | null> {
    const events = await this.readEvents(sessionId);
    return events.length > 0 ? events[events.length - 1] : null;
  }

  /**
   * Get event count for a session.
   *
   * @param sessionId - Session ID to count events for
   * @returns Number of events
   */
  async getEventCount(sessionId: string): Promise<number> {
    const eventsPath = this.eventsJsonlPath(sessionId);

    if (!existsSync(eventsPath)) {
      return 0;
    }

    const content = readFileSync(eventsPath, 'utf-8');
    return content.split('\n').filter((line) => line.trim()).length;
  }
}
