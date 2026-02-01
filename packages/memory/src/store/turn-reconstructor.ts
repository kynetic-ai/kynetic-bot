/**
 * TurnReconstructor - Reconstruct turn content from session events
 *
 * Turns store pointers to event ranges. Content is reconstructed on demand
 * by reading the referenced events from SessionStore.
 *
 * @see @mem-conversation
 */

import type { SessionStore } from './session-store.js';
import type { SessionEvent } from '../types/session.js';
import type { EventRange } from '../types/conversation.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of content reconstruction
 */
export interface ReconstructionResult {
  /** Reconstructed content */
  content: string;
  /** Whether any events were missing (gaps in sequence) */
  hasGaps: boolean;
  /** Number of events successfully read */
  eventsRead: number;
  /** Number of events that were missing */
  eventsMissing: number;
}

/**
 * Logger interface for warnings
 */
export interface TurnReconstructorLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * Options for TurnReconstructor
 */
export interface TurnReconstructorOptions {
  /** Logger for warnings */
  logger?: TurnReconstructorLogger;
}

// ============================================================================
// TurnReconstructor Implementation
// ============================================================================

/**
 * TurnReconstructor reconstructs turn content from session events.
 *
 * AC: @mem-conversation ac-4 - Content reconstructed from events
 * AC: @mem-conversation ac-5 - Returns partial content with [gap] markers
 *
 * @example
 * ```typescript
 * const reconstructor = new TurnReconstructor(sessionStore);
 *
 * const result = await reconstructor.reconstructContent(
 *   turn.session_id,
 *   turn.event_range
 * );
 *
 * console.log(result.content); // Reconstructed text
 * console.log(result.hasGaps); // true if some events were missing
 * ```
 */
export class TurnReconstructor {
  private readonly sessionStore: SessionStore;
  private readonly logger?: TurnReconstructorLogger;

  constructor(sessionStore: SessionStore, options: TurnReconstructorOptions = {}) {
    this.sessionStore = sessionStore;
    this.logger = options.logger;
  }

  /**
   * Reconstruct turn content from session events.
   *
   * AC: @mem-conversation ac-4 - Content reconstructed from events via TurnReconstructor
   * AC: @mem-conversation ac-5 - Returns partial content with [gap] markers for missing events
   *
   * @param sessionId - Session ID containing the events
   * @param eventRange - Range of events to reconstruct from
   * @returns Reconstruction result with content and gap information
   */
  async reconstructContent(
    sessionId: string,
    eventRange: EventRange
  ): Promise<ReconstructionResult> {
    // Read all events from the session
    const allEvents = await this.sessionStore.readEvents(sessionId);

    // Filter to the requested range
    const rangeEvents = allEvents.filter(
      (e) => e.seq >= eventRange.start_seq && e.seq <= eventRange.end_seq
    );

    // Calculate expected vs actual event count
    const expectedCount = eventRange.end_seq - eventRange.start_seq + 1;
    const actualCount = rangeEvents.length;
    const hasGaps = actualCount < expectedCount;

    if (hasGaps) {
      this.logger?.warn('Event gap detected during reconstruction', {
        sessionId,
        eventRange,
        expectedCount,
        actualCount,
      });
    }

    // Build content with gap detection
    const content = this.buildContentWithGaps(
      rangeEvents,
      eventRange.start_seq,
      eventRange.end_seq
    );

    return {
      content,
      hasGaps,
      eventsRead: actualCount,
      eventsMissing: expectedCount - actualCount,
    };
  }

  /**
   * Build content from events, inserting [gap] markers for missing sequences.
   *
   * AC: @mem-conversation ac-5 - [gap] markers for missing events
   */
  private buildContentWithGaps(events: SessionEvent[], startSeq: number, endSeq: number): string {
    if (events.length === 0) {
      // All events missing
      return '[gap: all events missing]';
    }

    // Sort events by seq
    const sortedEvents = [...events].sort((a, b) => a.seq - b.seq);

    // Build a map of seq -> event for O(1) lookup
    const eventMap = new Map<number, SessionEvent>();
    for (const event of sortedEvents) {
      eventMap.set(event.seq, event);
    }

    // Build content, tracking gaps
    const chunks: string[] = [];
    let inGap = false;
    let gapStart = -1;

    for (let seq = startSeq; seq <= endSeq; seq++) {
      const event = eventMap.get(seq);

      if (!event) {
        // Start or continue gap
        if (!inGap) {
          inGap = true;
          gapStart = seq;
        }
      } else {
        // End gap if we were in one
        if (inGap) {
          chunks.push(`[gap: events ${gapStart}-${seq - 1} missing]`);
          inGap = false;
        }

        // Extract content from event
        const content = this.extractContent(event);
        if (content) {
          chunks.push(content);
        }
      }
    }

    // Handle trailing gap
    if (inGap) {
      chunks.push(`[gap: events ${gapStart}-${endSeq} missing]`);
    }

    return chunks.join('');
  }

  /**
   * Extract text content from a session event.
   *
   * Supports:
   * - prompt.sent: User message content
   * - message.chunk: Streaming response chunk
   * - session.update: ACP SessionUpdate events (agent_message_chunk)
   */
  private extractContent(event: SessionEvent): string {
    switch (event.type) {
      case 'prompt.sent': {
        const data = event.data as { content?: string };
        return data.content ?? '';
      }

      case 'message.chunk': {
        const data = event.data as { content?: string };
        return data.content ?? '';
      }

      case 'session.update': {
        // ACP SessionUpdate events - extract text from agent_message_chunk
        const data = event.data as {
          update_type?: string;
          payload?: {
            content?: {
              text?: string;
            };
          };
        };

        if (data.update_type === 'agent_message_chunk') {
          return data.payload?.content?.text ?? '';
        }

        // Other update types don't contribute text content
        return '';
      }

      default:
        // Other event types (tool.call, tool.result, etc.) don't contribute text
        return '';
    }
  }

  /**
   * Convenience method to get just the content string.
   *
   * @param sessionId - Session ID containing the events
   * @param eventRange - Range of events to reconstruct from
   * @returns Reconstructed content string
   */
  async getContent(sessionId: string, eventRange: EventRange): Promise<string> {
    const result = await this.reconstructContent(sessionId, eventRange);
    return result.content;
  }
}
