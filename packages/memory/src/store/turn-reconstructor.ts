/**
 * TurnReconstructor - Reconstruct turn content from session events
 *
 * Turns store pointers to event ranges. Content is reconstructed on demand
 * by reading the referenced events from SessionStore.
 *
 * @see @mem-conversation
 * @see @mem-turn-reconstruct
 */

import { KyneticError } from '@kynetic-bot/core';
import { z, type ZodError } from 'zod';
import type { EventEmitter } from 'events';
import type { SessionStore } from './session-store.js';
import type { SessionEvent } from '../types/session.js';
import type { EventRange } from '../types/conversation.js';

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error thrown when TurnReconstructor validation fails.
 *
 * AC: @mem-turn-reconstruct ac-5 - Returns structured validation error with field details
 * AC: @trait-validated ac-1 - Returns structured error
 * AC: @trait-validated ac-2 - Identifies field in error
 */
export class TurnReconstructorValidationError extends KyneticError {
  readonly zodError?: ZodError;
  readonly field: string;

  constructor(message: string, field: string, zodError?: ZodError) {
    super(message, 'TURN_RECONSTRUCTOR_VALIDATION_ERROR', {
      field,
      issues: zodError?.issues,
    });
    this.zodError = zodError;
    this.field = field;
  }
}

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
  /** EventEmitter for reconstruction events */
  emitter?: EventEmitter;
  /** When true, summarize tool calls instead of ignoring them */
  summarizeTools?: boolean;
}

/**
 * Events emitted by TurnReconstructor
 *
 * AC: @trait-observable ac-1, ac-3 - Structured completion events
 */
export interface TurnReconstructorEvents {
  'reconstruction:completed': {
    sessionId: string;
    eventRange: EventRange;
    eventsRead: number;
    eventsMissing: number;
    hasGaps: boolean;
  };
  error: {
    error: Error;
    operation: string;
    sessionId?: string;
  };
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
  private readonly emitter?: EventEmitter;
  private readonly summarizeTools: boolean;

  constructor(sessionStore: SessionStore, options: TurnReconstructorOptions = {}) {
    this.sessionStore = sessionStore;
    this.logger = options.logger;
    this.emitter = options.emitter;
    this.summarizeTools = options.summarizeTools ?? false;
  }

  /**
   * Emit an event if emitter is configured.
   */
  private emit<K extends keyof TurnReconstructorEvents>(
    event: K,
    data: TurnReconstructorEvents[K]
  ): void {
    this.emitter?.emit(event, data);
  }

  /**
   * Reconstruct turn content from session events.
   *
   * AC: @mem-conversation ac-4 - Content reconstructed from events via TurnReconstructor
   * AC: @mem-conversation ac-5 - Returns partial content with [gap] markers for missing events
   * AC: @mem-turn-reconstruct ac-5 - Returns structured validation error with field details
   * AC: @mem-turn-reconstruct ac-6 - Returns error indicating invalid range
   *
   * @param sessionId - Session ID containing the events
   * @param eventRange - Range of events to reconstruct from
   * @returns Reconstruction result with content and gap information
   * @throws TurnReconstructorValidationError if input validation fails
   */
  async reconstructContent(
    sessionId: string,
    eventRange: EventRange
  ): Promise<ReconstructionResult> {
    // AC: @mem-turn-reconstruct ac-5 - Validate session_id is non-empty
    const sessionIdResult = z.string().min(1).safeParse(sessionId);
    if (!sessionIdResult.success) {
      const error = new TurnReconstructorValidationError(
        'session_id is required and must be non-empty',
        'session_id',
        sessionIdResult.error
      );
      this.emit('error', { error, operation: 'reconstructContent', sessionId });
      throw error;
    }

    // AC: @mem-turn-reconstruct ac-6 - Validate start_seq <= end_seq
    if (eventRange.start_seq > eventRange.end_seq) {
      const error = new TurnReconstructorValidationError(
        'start_seq must be <= end_seq',
        'event_range'
      );
      this.emit('error', { error, operation: 'reconstructContent', sessionId });
      throw error;
    }

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

    const result: ReconstructionResult = {
      content,
      hasGaps,
      eventsRead: actualCount,
      eventsMissing: expectedCount - actualCount,
    };

    // AC: @mem-turn-reconstruct ac-3 - Emit reconstruction_completed event with stats
    this.emit('reconstruction:completed', {
      sessionId,
      eventRange,
      eventsRead: result.eventsRead,
      eventsMissing: result.eventsMissing,
      hasGaps: result.hasGaps,
    });

    return result;
  }

  /**
   * Build content from events, inserting [gap] markers for missing sequences.
   *
   * AC: @mem-conversation ac-5 - [gap] markers for missing events
   * AC: @mem-turn-reconstruct ac-4 - Tool calls summarized when summarizeTools enabled
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

    // Build tool result map for matching calls with results when summarizing
    const toolResultMap = this.summarizeTools
      ? this.buildToolResultMap(sortedEvents)
      : new Map<string, SessionEvent>();

    // Track which tool.result events we've already processed (via their matching call)
    const processedToolResults = new Set<number>();

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

        // Skip tool.result events when summarizing - they're included with their call
        if (this.summarizeTools && event.type === 'tool.result') {
          if (processedToolResults.has(event.seq)) {
            continue;
          }
          // Orphan tool.result without a call - skip it
          continue;
        }

        // Extract content from event
        const content = this.extractContent(event, toolResultMap, processedToolResults);
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
   * Build a map from tool call identifiers to their result events.
   * Uses call_id if available, falls back to trace_id.
   */
  private buildToolResultMap(events: SessionEvent[]): Map<string, SessionEvent> {
    const resultMap = new Map<string, SessionEvent>();

    for (const event of events) {
      if (event.type === 'tool.result') {
        const data = event.data as { call_id?: string; trace_id?: string };
        const key = data.call_id ?? data.trace_id;
        if (key) {
          resultMap.set(key, event);
        }
      }
    }

    return resultMap;
  }

  /**
   * Extract text content from a session event.
   *
   * Supports:
   * - prompt.sent: User message content
   * - message.chunk: Streaming response chunk
   * - session.update: ACP SessionUpdate events (agent_message_chunk)
   * - tool.call: Tool invocations (when summarizeTools enabled)
   */
  private extractContent(
    event: SessionEvent,
    toolResultMap: Map<string, SessionEvent>,
    processedToolResults: Set<number>
  ): string {
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

      case 'tool.call': {
        if (!this.summarizeTools) {
          return '';
        }

        // AC: @mem-turn-reconstruct ac-4 - Summarize tool calls
        const callData = event.data as {
          tool_name?: string;
          call_id?: string;
          trace_id?: string;
          arguments?: Record<string, unknown>;
        };

        if (!callData.tool_name) {
          this.logger?.warn('tool.call event missing tool_name', { seq: event.seq });
          return '';
        }

        // Find matching result
        const key = callData.call_id ?? callData.trace_id;
        const resultEvent = key ? toolResultMap.get(key) : undefined;

        if (resultEvent) {
          processedToolResults.add(resultEvent.seq);
        }

        return this.formatToolSummary(callData, resultEvent?.data);
      }

      default:
        // Other event types (tool.result handled via call, etc.) don't contribute text
        return '';
    }
  }

  /**
   * Format a tool call summary.
   *
   * AC: @mem-turn-reconstruct ac-4 - Tool calls formatted as [tool: name | input | status | outcome]
   * AC: @mem-turn-reconstruct ac-8 - Orphaned calls show "pending" status
   */
  private formatToolSummary(
    callData: { tool_name?: string; arguments?: Record<string, unknown> },
    resultData?: unknown
  ): string {
    const toolName = callData.tool_name ?? 'unknown';
    const input = this.summarizeToolInput(toolName, callData.arguments);

    if (!resultData) {
      // AC: @mem-turn-reconstruct ac-8 - No result means pending
      return `[tool: ${toolName} | ${input} | pending]`;
    }

    const result = resultData as { success?: boolean; result?: unknown; error?: string };
    const status = result.success !== false ? 'success' : 'failure';
    const outcome = this.summarizeToolOutcome(toolName, result);

    if (outcome) {
      return `[tool: ${toolName} | ${input} | ${status} | ${outcome}]`;
    }
    return `[tool: ${toolName} | ${input} | ${status}]`;
  }

  /**
   * Summarize tool input arguments.
   *
   * AC: @mem-turn-reconstruct ac-7 - Input truncated to 100 characters with ellipsis
   */
  private summarizeToolInput(toolName: string, args?: Record<string, unknown>): string {
    if (!args) {
      return '';
    }

    let summary: string;

    switch (toolName.toLowerCase()) {
      case 'read':
      case 'write':
      case 'edit': {
        // Path-based tools - truncate from start to keep filename visible
        const rawPath = args.file_path ?? args.path;
        const path = typeof rawPath === 'string' ? rawPath : '';
        summary = this.truncate(path, 100, true);
        break;
      }

      case 'bash': {
        // Command - truncate from end
        const rawCommand = args.command;
        const command = typeof rawCommand === 'string' ? rawCommand : '';
        summary = this.truncate(command, 100, false);
        break;
      }

      case 'grep': {
        // Pattern + path hint
        const rawPattern = args.pattern;
        const rawPath = args.path;
        const pattern = typeof rawPattern === 'string' ? rawPattern : '';
        const path = typeof rawPath === 'string' ? rawPath : '';
        summary = this.truncate(`${pattern} in ${path}`, 100, false);
        break;
      }

      default: {
        // Generic - JSON stringify and truncate from end
        summary = this.truncate(JSON.stringify(args), 100, false);
        break;
      }
    }

    return summary;
  }

  /**
   * Summarize tool result outcome.
   */
  private summarizeToolOutcome(
    toolName: string,
    result: { success?: boolean; result?: unknown; error?: string }
  ): string {
    // Handle errors first
    if (result.success === false && result.error) {
      return this.truncate(result.error, 50, false);
    }

    const resultData = result.result;

    switch (toolName.toLowerCase()) {
      case 'read': {
        // Show line count if available
        if (typeof resultData === 'string') {
          const lines = resultData.split('\n').length;
          return `${lines} lines`;
        }
        return '';
      }

      case 'bash': {
        // Show exit code if non-zero
        const data = resultData as { exit_code?: number } | undefined;
        if (data?.exit_code && data.exit_code !== 0) {
          return `exit ${data.exit_code}`;
        }
        return '';
      }

      case 'grep': {
        // Show match count if available
        if (typeof resultData === 'string') {
          const matches = resultData.split('\n').filter((l) => l.trim()).length;
          return `${matches} matches`;
        }
        return '';
      }

      default:
        return '';
    }
  }

  /**
   * Truncate a string to a maximum length.
   *
   * @param str - String to truncate
   * @param maxLen - Maximum length
   * @param fromStart - If true, truncate from start (for file paths); otherwise from end
   */
  private truncate(str: string, maxLen: number, fromStart: boolean): string {
    if (str.length <= maxLen) {
      return str;
    }

    if (fromStart) {
      // Truncate from start, keep end (for file paths - keeps filename visible)
      return '...' + str.slice(-(maxLen - 3));
    } else {
      // Truncate from end, keep start
      return str.slice(0, maxLen - 3) + '...';
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
