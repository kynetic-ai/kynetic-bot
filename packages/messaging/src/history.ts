/**
 * ConversationHistory - High-level conversation history management
 *
 * Wraps ConversationStore to provide:
 * - Chronological message retrieval with timestamps
 * - Semantic boundary detection for context windowing
 * - Session cleanup with archival
 *
 * @see @msg-history
 */

import type {
  ConversationStore,
  ConversationTurn,
  ConversationMetadata,
  TurnReconstructor,
  EventRange,
} from '@kynetic-bot/memory';

// ============================================================================
// Types
// ============================================================================

/**
 * History entry with semantic boundary information
 */
export interface HistoryEntry {
  /** The conversation turn */
  turn: ConversationTurn;
  /** Whether this turn marks a semantic boundary (topic change) */
  semanticBoundary: boolean;
  /** Optional topic label for the segment starting at this boundary */
  topic?: string;
}

/**
 * Options for ConversationHistory
 */
export interface HistoryOptions {
  /** Session timeout in milliseconds (default: 30 minutes) */
  sessionTimeout?: number;
  /** Custom patterns to detect topic changes */
  boundaryPatterns?: RegExp[];
  /** Time gap (ms) that indicates a new topic (default: 5 minutes) */
  pauseThreshold?: number;
  /** TurnReconstructor for content retrieval (required for content-based boundary detection) */
  turnReconstructor?: TurnReconstructor;
}

/**
 * Input for adding a turn with event pointers
 *
 * Turns now store pointers to session events instead of content.
 * Content is reconstructed on demand via TurnReconstructor.
 */
export interface TurnInput {
  /** Role of the message author */
  role: 'user' | 'assistant' | 'system';
  /** Session ID that contains the events for this turn */
  session_id: string;
  /** Pointer to session events */
  event_range: EventRange;
  /** Platform message ID for idempotency/deduplication */
  message_id?: string;
  /** Optional platform-specific or custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of cleanup operation
 */
export interface CleanupResult {
  /** Whether the conversation was archived */
  archived: boolean;
  /** The archived conversation metadata (if archived) */
  conversation?: ConversationMetadata;
  /** Reason for cleanup */
  reason: 'timeout' | 'manual' | 'already_archived';
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const DEFAULT_PAUSE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

/**
 * Default patterns that indicate topic changes
 */
const DEFAULT_BOUNDARY_PATTERNS: RegExp[] = [
  /\b(?:let's talk about|changing topic|new topic|moving on to|switching to)\b/i,
  /\b(?:by the way|anyway|on another note|speaking of which)\b/i,
  /\b(?:can we discuss|i want to ask about|what about)\b/i,
];

// ============================================================================
// ConversationHistory Implementation
// ============================================================================

/**
 * ConversationHistory manages conversation history with semantic boundary detection.
 *
 * AC: @msg-history ac-1 - Chronological message retrieval with timestamps
 * AC: @msg-history ac-2 - Semantic boundary detection for context windowing
 * AC: @msg-history ac-3 - Cleanup with archival
 *
 * Note: Turns now store pointers to session events instead of content.
 * Content is reconstructed on demand via TurnReconstructor.
 *
 * @example
 * ```typescript
 * const history = new ConversationHistory(conversationStore, {
 *   turnReconstructor: new TurnReconstructor(sessionStore),
 * });
 *
 * // Get history for a session
 * const entries = await history.getHistory('discord:dm:user123');
 *
 * // Add a turn with event pointers
 * await history.addTurn('discord:dm:user123', {
 *   role: 'user',
 *   session_id: 'session-123',
 *   event_range: { start_seq: 0, end_seq: 0 },
 * });
 *
 * // Cleanup expired session
 * await history.cleanup('discord:dm:user123');
 * ```
 */
export class ConversationHistory {
  private readonly store: ConversationStore;
  private readonly sessionTimeout: number;
  private readonly boundaryPatterns: RegExp[];
  private readonly pauseThreshold: number;
  private readonly turnReconstructor?: TurnReconstructor;

  constructor(store: ConversationStore, options: HistoryOptions = {}) {
    this.store = store;
    this.sessionTimeout = options.sessionTimeout ?? DEFAULT_SESSION_TIMEOUT;
    this.boundaryPatterns = options.boundaryPatterns ?? DEFAULT_BOUNDARY_PATTERNS;
    this.pauseThreshold = options.pauseThreshold ?? DEFAULT_PAUSE_THRESHOLD;
    this.turnReconstructor = options.turnReconstructor;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get conversation history for a session key.
   *
   * AC: @msg-history ac-1 - Returns messages in chronological order with timestamps
   *
   * @param sessionKey - Session key to get history for
   * @returns Array of history entries with boundary markers, or empty array if no conversation
   */
  async getHistory(sessionKey: string): Promise<HistoryEntry[]> {
    const conversation = await this.store.getConversationBySessionKey(sessionKey);
    if (!conversation) {
      return [];
    }

    const turns = await this.store.readTurns(conversation.id);
    return this.analyzeHistory(turns);
  }

  /**
   * Get conversation history by conversation ID.
   *
   * @param conversationId - Conversation ID to get history for
   * @returns Array of history entries with boundary markers
   */
  async getHistoryById(conversationId: string): Promise<HistoryEntry[]> {
    const turns = await this.store.readTurns(conversationId);
    return this.analyzeHistory(turns);
  }

  /**
   * Get reconstructed content for a turn.
   *
   * AC: @mem-conversation ac-4 - Content reconstructed from events via TurnReconstructor
   *
   * @param turn - Turn to get content for
   * @returns Reconstructed content string, or empty string if no reconstructor
   */
  async getTurnContent(turn: ConversationTurn): Promise<string> {
    if (!this.turnReconstructor) {
      return '';
    }
    return this.turnReconstructor.getContent(turn.session_id, turn.event_range);
  }

  /**
   * Add a turn to the conversation history.
   *
   * Creates conversation if it doesn't exist.
   *
   * Note: Turns now store pointers to session events instead of content.
   * Content is reconstructed on demand via TurnReconstructor.
   *
   * @param sessionKey - Session key for the conversation
   * @param input - Turn input with event pointers
   * @returns The created turn with boundary analysis
   */
  async addTurn(sessionKey: string, input: TurnInput): Promise<HistoryEntry> {
    const conversation = await this.store.getOrCreateConversation(sessionKey);

    // Get previous turn for boundary detection
    const lastTurn = await this.store.getLastTurn(conversation.id);

    // Append the new turn with event pointers
    const turn = await this.store.appendTurn(conversation.id, input);

    // Detect if this turn marks a boundary (time-based only without content)
    const semanticBoundary = lastTurn ? await this.detectBoundaryAsync(lastTurn, turn) : false;

    return {
      turn,
      semanticBoundary,
    };
  }

  /**
   * Manually mark a semantic boundary at a specific turn.
   *
   * AC: @msg-history ac-2 - Marks boundary in history for context windowing
   *
   * Note: This is a view-level operation. The actual turn data in storage
   * doesn't store boundary markers - they're computed on read. This method
   * allows storing boundary hints in turn metadata for persistence.
   *
   * @param sessionKey - Session key for the conversation
   * @param seq - Sequence number of the turn to mark
   * @param markerSessionId - Session ID for the boundary marker turn
   * @param markerEventRange - Event range for the boundary marker turn
   * @param topic - Optional topic label for the new segment
   * @returns True if boundary was marked, false if turn not found
   */
  async markBoundary(
    sessionKey: string,
    seq: number,
    markerSessionId: string,
    markerEventRange: EventRange,
    topic?: string
  ): Promise<boolean> {
    const conversation = await this.store.getConversationBySessionKey(sessionKey);
    if (!conversation) {
      return false;
    }

    const turns = await this.store.readTurns(conversation.id);
    const turn = turns.find((t) => t.seq === seq);
    if (!turn) {
      return false;
    }

    // Store boundary hint in metadata via a new turn annotation
    // Since we can't modify existing turns, we append a system message
    // that marks the boundary
    await this.store.appendTurn(conversation.id, {
      role: 'system',
      session_id: markerSessionId,
      event_range: markerEventRange,
      metadata: {
        type: 'boundary_marker',
        marked_seq: seq,
        topic,
      },
    });

    return true;
  }

  /**
   * Check if a session has timed out.
   *
   * @param sessionKey - Session key to check
   * @returns True if the session has exceeded the timeout threshold
   */
  async isTimedOut(sessionKey: string): Promise<boolean> {
    const conversation = await this.store.getConversationBySessionKey(sessionKey);
    if (!conversation) {
      return false;
    }

    const lastTurn = await this.store.getLastTurn(conversation.id);
    if (!lastTurn) {
      // Empty conversation - check creation time
      const createdAt = new Date(conversation.created_at).getTime();
      return Date.now() - createdAt > this.sessionTimeout;
    }

    return Date.now() - lastTurn.ts > this.sessionTimeout;
  }

  /**
   * Cleanup a session - archive history and release resources.
   *
   * AC: @msg-history ac-3 - Archives history and releases active resources
   *
   * @param sessionKey - Session key to cleanup
   * @param force - If true, cleanup regardless of timeout status
   * @returns Cleanup result indicating what was done
   */
  async cleanup(sessionKey: string, force = false): Promise<CleanupResult> {
    const conversation = await this.store.getConversationBySessionKey(sessionKey);
    if (!conversation) {
      return {
        archived: false,
        reason: 'manual',
      };
    }

    // Already archived
    if (conversation.status === 'archived') {
      return {
        archived: false,
        conversation,
        reason: 'already_archived',
      };
    }

    // Check if timed out (unless forced)
    const timedOut = await this.isTimedOut(sessionKey);
    if (!force && !timedOut) {
      return {
        archived: false,
        conversation,
        reason: 'manual',
      };
    }

    // Archive the conversation
    const archived = await this.store.archiveConversation(conversation.id);

    return {
      archived: true,
      conversation: archived ?? undefined,
      reason: timedOut ? 'timeout' : 'manual',
    };
  }

  /**
   * Force cleanup regardless of timeout status.
   *
   * @param sessionKey - Session key to cleanup
   * @returns Cleanup result
   */
  async forceCleanup(sessionKey: string): Promise<CleanupResult> {
    return this.cleanup(sessionKey, true);
  }

  /**
   * Get history segmented by semantic boundaries.
   *
   * Returns turns grouped into segments based on detected topic changes.
   *
   * @param sessionKey - Session key to get segments for
   * @returns Array of segments, each containing an array of turns
   */
  async getSegments(sessionKey: string): Promise<HistoryEntry[][]> {
    const history = await this.getHistory(sessionKey);
    if (history.length === 0) {
      return [];
    }

    const segments: HistoryEntry[][] = [];
    let currentSegment: HistoryEntry[] = [];

    for (const entry of history) {
      if (entry.semanticBoundary && currentSegment.length > 0) {
        segments.push(currentSegment);
        currentSegment = [];
      }
      currentSegment.push(entry);
    }

    if (currentSegment.length > 0) {
      segments.push(currentSegment);
    }

    return segments;
  }

  /**
   * Get only the most recent segment (since last boundary).
   *
   * Useful for context windowing where you want to focus on the current topic.
   *
   * @param sessionKey - Session key to get current segment for
   * @returns Array of history entries in the current segment
   */
  async getCurrentSegment(sessionKey: string): Promise<HistoryEntry[]> {
    const segments = await this.getSegments(sessionKey);
    return segments.length > 0 ? segments[segments.length - 1] : [];
  }

  // ==========================================================================
  // Boundary Detection
  // ==========================================================================

  /**
   * Analyze history and mark semantic boundaries.
   *
   * AC: @msg-history ac-2 - Semantic boundary analysis
   *
   * Note: Content-based boundary detection requires TurnReconstructor.
   * Without it, only time-based detection is performed.
   */
  private async analyzeHistory(turns: ConversationTurn[]): Promise<HistoryEntry[]> {
    if (turns.length === 0) {
      return [];
    }

    const entries: HistoryEntry[] = [];

    // Check for boundary markers stored in metadata
    const markedBoundaries = new Set<number>();
    for (const turn of turns) {
      if (turn.role === 'system' && turn.metadata?.type === 'boundary_marker') {
        const markedSeq = turn.metadata.marked_seq as number;
        if (typeof markedSeq === 'number') {
          markedBoundaries.add(markedSeq);
        }
      }
    }

    // Filter out boundary marker system messages from output
    const contentTurns = turns.filter(
      (t) => !(t.role === 'system' && t.metadata?.type === 'boundary_marker')
    );

    for (let i = 0; i < contentTurns.length; i++) {
      const turn = contentTurns[i];
      const previousTurn = i > 0 ? contentTurns[i - 1] : null;

      // Check if manually marked
      const manuallyMarked = markedBoundaries.has(turn.seq);

      // Detect boundary automatically (async for content-based detection)
      const autoDetected = previousTurn
        ? await this.detectBoundaryAsync(previousTurn, turn)
        : false;

      entries.push({
        turn,
        semanticBoundary: manuallyMarked || autoDetected,
        topic: await this.extractTopicAsync(turn),
      });
    }

    return entries;
  }

  /**
   * Detect if current turn marks a semantic boundary from previous turn (async).
   *
   * AC: @msg-history ac-2 - Detects topic changes
   *
   * Detection strategies:
   * 1. Long pauses (> pauseThreshold)
   * 2. Explicit topic change patterns in content (requires TurnReconstructor)
   * 3. Question-answer pattern breaks (requires TurnReconstructor)
   */
  private async detectBoundaryAsync(
    previousTurn: ConversationTurn,
    currentTurn: ConversationTurn
  ): Promise<boolean> {
    // 1. Long pause detection (always works)
    const timeDiff = currentTurn.ts - previousTurn.ts;
    if (timeDiff > this.pauseThreshold) {
      return true;
    }

    // Content-based detection requires TurnReconstructor
    if (!this.turnReconstructor) {
      return false;
    }

    // Get content for both turns
    const currentContent = await this.getTurnContent(currentTurn);
    const previousContent = await this.getTurnContent(previousTurn);

    // 2. Explicit topic change patterns
    for (const pattern of this.boundaryPatterns) {
      if (pattern.test(currentContent)) {
        return true;
      }
    }

    // 3. Question-answer pattern break
    // If previous was a question (ends with ?) and current is also a question
    // from the same role, it might be a topic shift
    if (this.isQuestion(previousContent) && this.isQuestion(currentContent)) {
      if (previousTurn.role === currentTurn.role) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if content appears to be a question
   */
  private isQuestion(content: string): boolean {
    return content.trim().endsWith('?');
  }

  /**
   * Try to extract a topic from the turn content (async)
   */
  private async extractTopicAsync(turn: ConversationTurn): Promise<string | undefined> {
    if (!this.turnReconstructor) {
      return undefined;
    }

    const content = await this.getTurnContent(turn);

    // Look for "let's talk about X" patterns
    const aboutMatch = content.match(/(?:let's talk about|discussing|about)\s+(.+?)(?:\.|,|$)/i);
    if (aboutMatch) {
      return aboutMatch[1].trim();
    }

    return undefined;
  }
}
