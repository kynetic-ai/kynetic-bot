/**
 * ConversationStore - Persistent conversation and turn storage
 *
 * Manages conversations with YAML metadata and JSONL turn logs.
 * Provides idempotent turn appends and session linkage validation.
 *
 * @see @mem-conversation
 */

import * as fs from 'node:fs/promises';
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { ulid } from 'ulid';
import { EventEmitter } from 'node:events';
import { ZodError } from 'zod';
import { KyneticError } from '@kynetic-bot/core';

import {
  ConversationMetadata,
  ConversationMetadataSchema,
  ConversationStatus,
  ConversationTurn,
  ConversationTurnSchema,
  ConversationTurnInputSchema,
  type ConversationTurnInput,
} from '../types/conversation.js';
import type { SessionStore } from './session-store.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for creating a ConversationStore
 */
export interface ConversationStoreOptions {
  /** Base directory for conversation storage (e.g., .kbot/) */
  baseDir: string;
  /** SessionStore for validating session_id references (optional) */
  sessionStore?: SessionStore;
  /** Event emitter for observability (optional) */
  emitter?: EventEmitter;
}

/**
 * Options for listing conversations
 */
export interface ListConversationsOptions {
  /** Filter by conversation status */
  status?: ConversationStatus;
  /** Maximum number of conversations to return */
  limit?: number;
}

/**
 * Error thrown when conversation operations fail
 */
export class ConversationStoreError extends KyneticError {
  readonly conversationId?: string;

  constructor(
    message: string,
    code: string,
    conversationId?: string,
    context?: Record<string, unknown>,
  ) {
    super(message, `CONVERSATION_STORE_${code}`, { ...context, conversationId });
    this.conversationId = conversationId;
  }
}

/**
 * Error thrown when Zod validation fails
 *
 * AC: @mem-conversation ac-6 - Rejects with Zod validation error including field details
 */
export class ConversationValidationError extends KyneticError {
  readonly zodError: ZodError;
  readonly field?: string;

  constructor(message: string, zodError: ZodError, field?: string) {
    super(message, 'CONVERSATION_VALIDATION_ERROR', {
      field,
      issues: zodError.issues,
    });
    this.zodError = zodError;
    this.field = field;
  }
}

// ============================================================================
// Event Types for Observability
// ============================================================================

/**
 * Events emitted by ConversationStore for observability
 *
 * AC: @mem-conversation ac-5 - Emits structured event for observability
 */
export interface ConversationStoreEvents {
  'conversation:created': { conversation: ConversationMetadata };
  'conversation:updated': { conversationId: string; turnCount: number };
  'conversation:archived': { conversationId: string };
  'turn:appended': { conversationId: string; turn: ConversationTurn; wasDuplicate: boolean };
  'error': { error: Error; operation: string; conversationId?: string };
}

// ============================================================================
// Session Key Index
// ============================================================================

/**
 * Session key index maps session_key -> conversation_id for fast lookup
 */
interface SessionKeyIndex {
  [sessionKey: string]: string;
}

// ============================================================================
// ConversationStore Implementation
// ============================================================================

/**
 * ConversationStore manages conversation storage with JSONL turn logs.
 *
 * Storage layout:
 * ```
 * {baseDir}/conversations/{conversation-id}/
 * ├── conversation.yaml  # ConversationMetadata
 * └── turns.jsonl        # Append-only turn log
 *
 * {baseDir}/conversations/session-key-index.json  # Session key -> conversation ID
 * ```
 *
 * @example
 * ```typescript
 * const store = new ConversationStore({ baseDir: '.kbot' });
 *
 * // Create a new conversation
 * const conversation = await store.createConversation('discord:dm:user123');
 *
 * // Append a turn
 * await store.appendTurn(conversation.id, {
 *   role: 'user',
 *   content: 'Hello!',
 *   message_id: 'msg-123',
 * });
 * ```
 */
export class ConversationStore {
  private readonly baseDir: string;
  private readonly conversationsDir: string;
  private readonly sessionStore?: SessionStore;
  private readonly emitter?: EventEmitter;

  constructor(options: ConversationStoreOptions) {
    this.baseDir = options.baseDir;
    this.conversationsDir = path.join(options.baseDir, 'conversations');
    this.sessionStore = options.sessionStore;
    this.emitter = options.emitter;
  }

  // ==========================================================================
  // Path Helpers
  // ==========================================================================

  /**
   * Get the directory path for a conversation
   */
  private conversationDir(conversationId: string): string {
    return path.join(this.conversationsDir, conversationId);
  }

  /**
   * Get the path to conversation.yaml for a conversation
   */
  private conversationYamlPath(conversationId: string): string {
    return path.join(this.conversationDir(conversationId), 'conversation.yaml');
  }

  /**
   * Get the path to turns.jsonl for a conversation
   */
  private turnsJsonlPath(conversationId: string): string {
    return path.join(this.conversationDir(conversationId), 'turns.jsonl');
  }

  /**
   * Get the path to the lock file for a conversation
   */
  private lockFilePath(conversationId: string): string {
    return path.join(this.conversationDir(conversationId), '.lock');
  }

  /**
   * Get the path to the session key index
   */
  private sessionKeyIndexPath(): string {
    return path.join(this.conversationsDir, 'session-key-index.json');
  }

  /**
   * Get the path to the session key index lock file
   */
  private sessionKeyIndexLockPath(): string {
    return path.join(this.conversationsDir, '.session-key-index.lock');
  }

  /**
   * Get the path to the message ID index for a conversation.
   * Maps message_id -> seq for O(1) duplicate detection.
   */
  private messageIdIndexPath(conversationId: string): string {
    return path.join(this.conversationDir(conversationId), 'message-id-index.json');
  }

  // ==========================================================================
  // Lock Helpers
  // ==========================================================================

  /**
   * Acquire a lock for a conversation's turn log.
   * Uses simple file-based locking for concurrency safety.
   * Async to yield event loop during wait, preventing starvation.
   */
  private async acquireLock(conversationId: string, timeout = 5000): Promise<boolean> {
    const lockPath = this.lockFilePath(conversationId);
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        return true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // Yield to event loop to allow lock holder to complete
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        throw err;
      }
    }
    return false;
  }

  /**
   * Release a conversation's lock
   */
  private releaseLock(conversationId: string): void {
    const lockPath = this.lockFilePath(conversationId);
    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore if lock file doesn't exist
    }
  }

  /**
   * Acquire lock for session key index operations
   * Async to yield event loop during wait, preventing starvation.
   */
  private async acquireIndexLock(timeout = 5000): Promise<boolean> {
    const lockPath = this.sessionKeyIndexLockPath();
    const startTime = Date.now();

    // Ensure conversations directory exists
    if (!existsSync(this.conversationsDir)) {
      return true; // First operation will create directory
    }

    while (Date.now() - startTime < timeout) {
      try {
        writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        return true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          // Yield to event loop to allow lock holder to complete
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        throw err;
      }
    }
    return false;
  }

  /**
   * Release session key index lock
   */
  private releaseIndexLock(): void {
    const lockPath = this.sessionKeyIndexLockPath();
    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore if lock file doesn't exist
    }
  }

  // ==========================================================================
  // Emit Helper
  // ==========================================================================

  /**
   * Emit an event if emitter is configured
   */
  private emit<K extends keyof ConversationStoreEvents>(
    event: K,
    data: ConversationStoreEvents[K],
  ): void {
    if (this.emitter) {
      this.emitter.emit(event, data);
    }
  }

  // ==========================================================================
  // Message ID Index Operations (O(1) duplicate detection)
  // ==========================================================================

  /**
   * Message ID index maps message_id -> seq for fast duplicate lookups
   */
  private messageIdIndexCache = new Map<string, Map<string, number>>();

  /**
   * Read the message ID index for a conversation.
   * Uses in-memory cache with file fallback.
   */
  private readMessageIdIndex(conversationId: string): Map<string, number> {
    // Check cache first
    const cached = this.messageIdIndexCache.get(conversationId);
    if (cached) {
      return cached;
    }

    // Read from file
    const indexPath = this.messageIdIndexPath(conversationId);
    if (!existsSync(indexPath)) {
      const emptyIndex = new Map<string, number>();
      this.messageIdIndexCache.set(conversationId, emptyIndex);
      return emptyIndex;
    }

    try {
      const content = readFileSync(indexPath, 'utf-8');
      const data = JSON.parse(content) as Record<string, number>;
      const index = new Map<string, number>(Object.entries(data));
      this.messageIdIndexCache.set(conversationId, index);
      return index;
    } catch {
      // If index is corrupted, return empty and it will be rebuilt on next write
      const emptyIndex = new Map<string, number>();
      this.messageIdIndexCache.set(conversationId, emptyIndex);
      return emptyIndex;
    }
  }

  /**
   * Write the message ID index for a conversation.
   * Updates both cache and file.
   */
  private writeMessageIdIndex(conversationId: string, index: Map<string, number>): void {
    // Update cache
    this.messageIdIndexCache.set(conversationId, index);

    // Write to file
    const indexPath = this.messageIdIndexPath(conversationId);
    const data = Object.fromEntries(index);
    writeFileSync(indexPath, JSON.stringify(data), 'utf-8');
  }

  /**
   * Add a message ID to the index.
   * Called after successfully appending a turn.
   */
  private addToMessageIdIndex(conversationId: string, messageId: string, seq: number): void {
    const index = this.readMessageIdIndex(conversationId);
    index.set(messageId, seq);
    this.writeMessageIdIndex(conversationId, index);
  }

  /**
   * Check if a message ID exists in the index.
   * Returns the seq number if found, undefined otherwise.
   */
  private checkMessageIdIndex(conversationId: string, messageId: string): number | undefined {
    const index = this.readMessageIdIndex(conversationId);
    return index.get(messageId);
  }

  /**
   * Rebuild the message ID index from turns.jsonl.
   * Used during recovery or when index is missing/corrupted.
   */
  private async rebuildMessageIdIndex(conversationId: string): Promise<void> {
    const turns = await this.readTurnsInternal(conversationId);
    const index = new Map<string, number>();

    for (const turn of turns) {
      if (turn.message_id) {
        index.set(turn.message_id, turn.seq);
      }
    }

    this.writeMessageIdIndex(conversationId, index);
  }

  // ==========================================================================
  // Session Key Index Operations
  // ==========================================================================

  /**
   * Read the session key index
   */
  private async readSessionKeyIndex(): Promise<SessionKeyIndex> {
    const indexPath = this.sessionKeyIndexPath();
    if (!existsSync(indexPath)) {
      return {};
    }

    try {
      const content = await fs.readFile(indexPath, 'utf-8');
      return JSON.parse(content) as SessionKeyIndex;
    } catch {
      return {};
    }
  }

  /**
   * Write the session key index
   */
  private async writeSessionKeyIndex(index: SessionKeyIndex): Promise<void> {
    const indexPath = this.sessionKeyIndexPath();
    await fs.mkdir(this.conversationsDir, { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  }

  /**
   * Add a session key to the index.
   * Uses locking to prevent race conditions with concurrent createConversation calls.
   */
  private async addToSessionKeyIndex(sessionKey: string, conversationId: string): Promise<void> {
    if (!(await this.acquireIndexLock())) {
      throw new ConversationStoreError(
        'Failed to acquire lock for session key index',
        'INDEX_LOCK_FAILED',
      );
    }

    try {
      const index = await this.readSessionKeyIndex();
      index[sessionKey] = conversationId;
      await this.writeSessionKeyIndex(index);
    } finally {
      this.releaseIndexLock();
    }
  }

  // ==========================================================================
  // Conversation Operations
  // ==========================================================================

  /**
   * Create a new conversation for a session key.
   *
   * AC: @mem-conversation ac-1 - Creates conversation with turns.jsonl
   *
   * @param sessionKey - Session key for routing (platform:kind:identifier format)
   * @returns Created conversation metadata
   */
  async createConversation(sessionKey: string): Promise<ConversationMetadata> {
    const conversationId = ulid();
    const now = new Date().toISOString();

    const metadata: ConversationMetadata = {
      id: conversationId,
      session_key: sessionKey,
      status: 'active',
      created_at: now,
      updated_at: now,
      turn_count: 0,
    };

    // Validate
    const result = ConversationMetadataSchema.safeParse(metadata);
    if (!result.success) {
      throw new ConversationValidationError(
        `Invalid conversation metadata: ${result.error.message}`,
        result.error,
      );
    }

    // Create conversation directory
    const dir = this.conversationDir(conversationId);
    await fs.mkdir(dir, { recursive: true });

    // Write conversation.yaml
    const yamlContent = yamlStringify(metadata);
    await fs.writeFile(this.conversationYamlPath(conversationId), yamlContent, 'utf-8');

    // Create empty turns.jsonl
    await fs.writeFile(this.turnsJsonlPath(conversationId), '', 'utf-8');

    // Add to session key index
    await this.addToSessionKeyIndex(sessionKey, conversationId);

    // Emit event
    this.emit('conversation:created', { conversation: metadata });

    return metadata;
  }

  /**
   * Get or create a conversation for a session key.
   *
   * @param sessionKey - Session key for routing
   * @returns Existing or newly created conversation metadata
   */
  async getOrCreateConversation(sessionKey: string): Promise<ConversationMetadata> {
    const existing = await this.getConversationBySessionKey(sessionKey);
    if (existing) {
      return existing;
    }
    return this.createConversation(sessionKey);
  }

  /**
   * Get conversation metadata by ID.
   *
   * @param conversationId - Conversation ID to look up
   * @returns Conversation metadata or null if not found
   */
  async getConversation(conversationId: string): Promise<ConversationMetadata | null> {
    const yamlPath = this.conversationYamlPath(conversationId);

    if (!existsSync(yamlPath)) {
      return null;
    }

    try {
      const content = await fs.readFile(yamlPath, 'utf-8');
      const data: unknown = yamlParse(content);

      const result = ConversationMetadataSchema.safeParse(data);
      if (!result.success) {
        this.emit('error', {
          error: new Error(`Corrupted conversation.yaml: ${result.error.message}`),
          operation: 'getConversation',
          conversationId,
        });
        return null;
      }

      return result.data;
    } catch (error) {
      this.emit('error', {
        error: error as Error,
        operation: 'getConversation',
        conversationId,
      });
      return null;
    }
  }

  /**
   * Get conversation by session key.
   *
   * @param sessionKey - Session key to look up
   * @returns Conversation metadata or null if not found
   */
  async getConversationBySessionKey(sessionKey: string): Promise<ConversationMetadata | null> {
    const index = await this.readSessionKeyIndex();
    const conversationId = index[sessionKey];
    if (!conversationId) {
      return null;
    }
    return this.getConversation(conversationId);
  }

  /**
   * Check if a conversation exists.
   *
   * @param conversationId - Conversation ID to check
   * @returns True if conversation exists
   */
  async conversationExists(conversationId: string): Promise<boolean> {
    return existsSync(this.conversationYamlPath(conversationId));
  }

  /**
   * List conversations with optional filtering.
   *
   * @param options - Filter options
   * @returns Array of conversation metadata
   */
  async listConversations(options?: ListConversationsOptions): Promise<ConversationMetadata[]> {
    if (!existsSync(this.conversationsDir)) {
      return [];
    }

    const entries = await fs.readdir(this.conversationsDir, { withFileTypes: true });
    const convDirs = entries.filter((e) => e.isDirectory());

    const conversations: ConversationMetadata[] = [];

    for (const dir of convDirs) {
      const conversation = await this.getConversation(dir.name);
      if (!conversation) continue;

      if (options?.status && conversation.status !== options.status) continue;

      conversations.push(conversation);

      if (options?.limit && conversations.length >= options.limit) break;
    }

    // Sort by updated_at descending (most recent first)
    conversations.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    return conversations;
  }

  /**
   * Archive a conversation.
   *
   * @param conversationId - Conversation ID to archive
   * @returns Updated conversation metadata or null if not found
   */
  async archiveConversation(conversationId: string): Promise<ConversationMetadata | null> {
    const conversation = await this.getConversation(conversationId);
    if (!conversation) {
      return null;
    }

    conversation.status = 'archived';
    conversation.updated_at = new Date().toISOString();

    const yamlContent = yamlStringify(conversation);
    await fs.writeFile(this.conversationYamlPath(conversationId), yamlContent, 'utf-8');

    this.emit('conversation:archived', { conversationId });

    return conversation;
  }

  /**
   * Update conversation metadata after turn append
   */
  private async updateConversationTurnCount(
    conversationId: string,
    turnCount: number,
  ): Promise<void> {
    const conversation = await this.getConversation(conversationId);
    if (!conversation) return;

    conversation.turn_count = turnCount;
    conversation.updated_at = new Date().toISOString();

    const yamlContent = yamlStringify(conversation);
    await fs.writeFile(this.conversationYamlPath(conversationId), yamlContent, 'utf-8');

    this.emit('conversation:updated', { conversationId, turnCount });
  }

  // ==========================================================================
  // Turn Operations
  // ==========================================================================

  /**
   * Append a turn to a conversation's turn log.
   *
   * AC: @mem-conversation ac-1 - User turn with (role, session_id, event_range)
   * AC: @mem-conversation ac-2 - Assistant turn with (role, session_id, event_range)
   * AC: @mem-conversation ac-6 - Idempotent by message_id
   * AC: @mem-conversation ac-7 - Emits turn_appended event
   * AC: @mem-conversation ac-8 - Rejects with Zod validation error
   *
   * @param conversationId - Conversation ID to append turn to
   * @param input - Turn input data (must include session_id and event_range)
   * @returns Created turn with ts and seq assigned
   * @throws ConversationStoreError if conversation not found or session validation fails
   * @throws ConversationValidationError if input validation fails
   */
  async appendTurn(conversationId: string, input: ConversationTurnInput): Promise<ConversationTurn> {
    // Validate input
    const parseResult = ConversationTurnInputSchema.safeParse(input);
    if (!parseResult.success) {
      throw new ConversationValidationError(
        `Invalid turn input: ${parseResult.error.message}`,
        parseResult.error,
        parseResult.error.issues[0]?.path.join('.'),
      );
    }

    const validInput = parseResult.data;

    // Check conversation exists
    if (!existsSync(this.conversationDir(conversationId))) {
      throw new ConversationStoreError(
        `Conversation not found: ${conversationId}`,
        'CONVERSATION_NOT_FOUND',
        conversationId,
      );
    }

    // Validate session_id references a valid session
    if (this.sessionStore) {
      const session = await this.sessionStore.getSession(validInput.session_id);
      if (!session) {
        throw new ConversationStoreError(
          `Invalid session_id: session not found: ${validInput.session_id}`,
          'INVALID_SESSION_REF',
          conversationId,
          { session_id: validInput.session_id },
        );
      }
    }

    // Acquire lock for thread-safe operations
    if (!(await this.acquireLock(conversationId))) {
      throw new ConversationStoreError(
        `Failed to acquire lock for conversation: ${conversationId}`,
        'LOCK_FAILED',
        conversationId,
      );
    }

    try {
      const turnsPath = this.turnsJsonlPath(conversationId);

      // Check for duplicate message_id using O(1) index lookup (AC-4 idempotency)
      if (validInput.message_id) {
        const existingSeq = this.checkMessageIdIndex(conversationId, validInput.message_id);
        if (existingSeq !== undefined) {
          // Duplicate found - read the actual turn to return it
          const existingTurns = await this.readTurnsInternal(conversationId);
          const duplicate = existingTurns.find((t) => t.seq === existingSeq);
          if (duplicate) {
            this.emit('turn:appended', { conversationId, turn: duplicate, wasDuplicate: true });
            return duplicate;
          }
          // Index was stale - fall through to append
        }
      }

      // Get current turn count for seq assignment
      let seq = 0;
      if (existsSync(turnsPath)) {
        const content = readFileSync(turnsPath, 'utf-8');
        const lines = content.split('\n').filter((line) => line.trim());
        seq = lines.length;
      }

      // Build full turn with auto-assigned fields
      // AC: @mem-conversation ac-1, ac-2 - Turn with session_id and event_range
      const turn: ConversationTurn = {
        ts: validInput.ts ?? Date.now(),
        seq: validInput.seq ?? seq,
        role: validInput.role,
        session_id: validInput.session_id,
        event_range: validInput.event_range,
        message_id: validInput.message_id,
        metadata: validInput.metadata,
      };

      // Atomic append
      const line = JSON.stringify(turn) + '\n';
      appendFileSync(turnsPath, line, 'utf-8');

      // Update message ID index if message_id is present
      if (turn.message_id) {
        this.addToMessageIdIndex(conversationId, turn.message_id, turn.seq);
      }

      // Update conversation turn count
      await this.updateConversationTurnCount(conversationId, seq + 1);

      // Emit event
      this.emit('turn:appended', { conversationId, turn, wasDuplicate: false });

      return turn;
    } finally {
      this.releaseLock(conversationId);
    }
  }

  /**
   * Internal read without lock (for use inside locked operations)
   */
  private async readTurnsInternal(conversationId: string): Promise<ConversationTurn[]> {
    const turnsPath = this.turnsJsonlPath(conversationId);

    if (!existsSync(turnsPath)) {
      return [];
    }

    const content = await fs.readFile(turnsPath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    const turns: ConversationTurn[] = [];

    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        const result = ConversationTurnSchema.safeParse(parsed);
        if (result.success) {
          turns.push(result.data);
        }
        // Skip invalid entries silently in internal method
      } catch {
        // Skip invalid JSON silently in internal method
      }
    }

    return turns;
  }

  /**
   * Read all turns for a conversation.
   *
   * AC: @mem-conversation ac-3 - Skips invalid JSON lines with warning
   *
   * Also rebuilds the message ID index if missing (recovery scenario).
   *
   * @param conversationId - Conversation ID to read turns for
   * @returns Array of valid turns sorted by seq
   */
  async readTurns(conversationId: string): Promise<ConversationTurn[]> {
    const turnsPath = this.turnsJsonlPath(conversationId);

    if (!existsSync(turnsPath)) {
      return [];
    }

    const content = await fs.readFile(turnsPath, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim());

    const turns: ConversationTurn[] = [];
    let skippedJson = 0;
    let skippedValidation = 0;

    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        const result = ConversationTurnSchema.safeParse(parsed);
        if (result.success) {
          turns.push(result.data);
        } else {
          skippedValidation++;
        }
      } catch {
        skippedJson++;
      }
    }

    // Emit single summary error if any lines were skipped
    const totalSkipped = skippedJson + skippedValidation;
    if (totalSkipped > 0) {
      this.emit('error', {
        error: new Error(
          `Skipped ${totalSkipped} invalid lines in turns.jsonl ` +
            `(${skippedJson} JSON errors, ${skippedValidation} schema validation failures)`,
        ),
        operation: 'readTurns',
        conversationId,
      });
    }

    // Sort by seq
    turns.sort((a, b) => a.seq - b.seq);

    // Rebuild message ID index if missing (recovery scenario)
    const indexPath = this.messageIdIndexPath(conversationId);
    if (!existsSync(indexPath) && turns.length > 0) {
      const index = new Map<string, number>();
      for (const turn of turns) {
        if (turn.message_id) {
          index.set(turn.message_id, turn.seq);
        }
      }
      this.writeMessageIdIndex(conversationId, index);
    }

    return turns;
  }

  /**
   * Read turns since a timestamp.
   *
   * @param conversationId - Conversation ID to read turns for
   * @param since - Start timestamp (inclusive)
   * @param until - End timestamp (inclusive, optional)
   * @returns Array of turns in range
   */
  async readTurnsSince(
    conversationId: string,
    since: number,
    until?: number,
  ): Promise<ConversationTurn[]> {
    const turns = await this.readTurns(conversationId);

    return turns.filter((turn) => {
      if (turn.ts < since) return false;
      if (until !== undefined && turn.ts > until) return false;
      return true;
    });
  }

  /**
   * Get the last turn for a conversation.
   *
   * @param conversationId - Conversation ID to get last turn for
   * @returns Last turn or null if no turns
   */
  async getLastTurn(conversationId: string): Promise<ConversationTurn | null> {
    const turns = await this.readTurns(conversationId);
    return turns.length > 0 ? turns[turns.length - 1] : null;
  }

  /**
   * Get turn count for a conversation.
   *
   * @param conversationId - Conversation ID to count turns for
   * @returns Number of turns
   */
  async getTurnCount(conversationId: string): Promise<number> {
    const turnsPath = this.turnsJsonlPath(conversationId);

    if (!existsSync(turnsPath)) {
      return 0;
    }

    const content = readFileSync(turnsPath, 'utf-8');
    return content.split('\n').filter((line) => line.trim()).length;
  }
}
