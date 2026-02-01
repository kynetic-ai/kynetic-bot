/**
 * CondensedToolDisplay - Manages condensed tool display mode for DMs and fallback scenarios
 *
 * In DM channels (no thread support), shows first 5 tools as full widgets and
 * condenses additional tools into a status message with progressive naming.
 *
 * @see @discord-tool-widgets ac-18, ac-19, ac-20
 */

import { createLogger, type Logger } from '@kynetic-bot/core';

const MAX_VISIBLE_WIDGETS = 5;
const PROGRESSIVE_NAME_LIMIT = 3;
const STATUS_COUNT_THRESHOLD = 8;

/**
 * Minimal tool call info needed for display tracking
 */
export interface CondensedToolCall {
  toolCallId: string;
  toolName: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

/**
 * Display state for a channel/session combination
 */
export interface CondensedDisplayState {
  sessionId: string;
  channelId: string;
  /** First 5 tools - shown as full widgets */
  visibleTools: CondensedToolCall[];
  /** 6th+ tools - shown in status message */
  condensedTools: CondensedToolCall[];
  /** Status message ID for overflow updates */
  statusMessageId: string | null;
}

/**
 * CondensedToolDisplay - Tracks tools and determines display mode
 *
 * Used when threads aren't available (DMs, permission failures, deleted threads).
 * First 5 tools render as full widgets, additional tools are condensed into
 * a status message that updates progressively.
 */
export class CondensedToolDisplay {
  private readonly logger: Logger;
  private readonly displayStates = new Map<string, CondensedDisplayState>();

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger('condensed-tool-display');
  }

  /**
   * Add a tool call and determine display mode
   *
   * AC: @discord-tool-widgets ac-18 - First 5 as widgets, 6th+ condensed
   *
   * @param sessionId - Session ID for isolation
   * @param channelId - Discord channel ID
   * @param toolCall - Tool call to track
   * @returns 'widget' if should be shown as full widget, 'condensed' if overflow
   */
  addToolCall(
    sessionId: string,
    channelId: string,
    toolCall: CondensedToolCall
  ): 'widget' | 'condensed' {
    const key = this.buildKey(sessionId, channelId);
    let state = this.displayStates.get(key);

    if (!state) {
      state = {
        sessionId,
        channelId,
        visibleTools: [],
        condensedTools: [],
        statusMessageId: null,
      };
      this.displayStates.set(key, state);
    }

    // Check if this tool is already tracked (idempotent)
    const existsInVisible = state.visibleTools.some((t) => t.toolCallId === toolCall.toolCallId);
    const existsInCondensed = state.condensedTools.some((t) => t.toolCallId === toolCall.toolCallId);

    if (existsInVisible || existsInCondensed) {
      this.logger.debug('Tool call already tracked', { toolCallId: toolCall.toolCallId });
      return existsInVisible ? 'widget' : 'condensed';
    }

    // First 5 go to visible, rest to condensed
    if (state.visibleTools.length < MAX_VISIBLE_WIDGETS) {
      state.visibleTools.push(toolCall);
      this.logger.debug('Added tool to visible', {
        toolCallId: toolCall.toolCallId,
        position: state.visibleTools.length,
      });
      return 'widget';
    } else {
      state.condensedTools.push(toolCall);
      this.logger.debug('Added tool to condensed', {
        toolCallId: toolCall.toolCallId,
        position: state.condensedTools.length,
      });
      return 'condensed';
    }
  }

  /**
   * Update tool status
   *
   * AC: @discord-tool-widgets ac-20 - Status message updates when condensed tool completes
   *
   * @param sessionId - Session ID
   * @param channelId - Channel ID
   * @param toolCallId - Tool call ID to update
   * @param status - New status
   * @returns True if the tool was found and updated, false otherwise
   */
  updateToolCall(
    sessionId: string,
    channelId: string,
    toolCallId: string,
    status: CondensedToolCall['status']
  ): boolean {
    const key = this.buildKey(sessionId, channelId);
    const state = this.displayStates.get(key);

    if (!state) {
      return false;
    }

    // Check visible tools
    const visibleTool = state.visibleTools.find((t) => t.toolCallId === toolCallId);
    if (visibleTool) {
      visibleTool.status = status;
      this.logger.debug('Updated visible tool', { toolCallId, status });
      return true;
    }

    // Check condensed tools
    const condensedTool = state.condensedTools.find((t) => t.toolCallId === toolCallId);
    if (condensedTool) {
      condensedTool.status = status;
      this.logger.debug('Updated condensed tool', { toolCallId, status });
      return true;
    }

    return false;
  }

  /**
   * Check if a tool call is condensed (not shown as widget)
   *
   * @param sessionId - Session ID
   * @param channelId - Channel ID
   * @param toolCallId - Tool call ID to check
   * @returns True if tool is in condensed list
   */
  isCondensed(sessionId: string, channelId: string, toolCallId: string): boolean {
    const key = this.buildKey(sessionId, channelId);
    const state = this.displayStates.get(key);

    if (!state) {
      return false;
    }

    return state.condensedTools.some((t) => t.toolCallId === toolCallId);
  }

  /**
   * Check if status message needs to be created or updated
   *
   * @param sessionId - Session ID
   * @param channelId - Channel ID
   * @returns True if there are condensed tools that need status message
   */
  hasCondensedTools(sessionId: string, channelId: string): boolean {
    const key = this.buildKey(sessionId, channelId);
    const state = this.displayStates.get(key);

    return state ? state.condensedTools.length > 0 : false;
  }

  /**
   * Get status text for overflow message
   *
   * AC: @discord-tool-widgets ac-19 - Progressive names, then counts
   *
   * Format:
   * - Small overflow (<=3 condensed): "+ bash, read, write running..."
   * - Large overflow (>3 condensed) or many total (>8): "5 completed, 3 running"
   *
   * @param sessionId - Session ID
   * @param channelId - Channel ID
   * @returns Status text or null if no condensed tools
   */
  getStatusText(sessionId: string, channelId: string): string | null {
    const key = this.buildKey(sessionId, channelId);
    const state = this.displayStates.get(key);

    if (!state || state.condensedTools.length === 0) {
      return null;
    }

    const allTools = [...state.visibleTools, ...state.condensedTools];
    const totalCount = allTools.length;

    // Count by status across all tools
    const completed = allTools.filter((t) => t.status === 'completed').length;
    const running = allTools.filter(
      (t) => t.status === 'in_progress' || t.status === 'pending'
    ).length;
    const failed = allTools.filter((t) => t.status === 'failed').length;

    // Use counts when total is large (>8) or condensed list is large (>3)
    if (totalCount > STATUS_COUNT_THRESHOLD || state.condensedTools.length > PROGRESSIVE_NAME_LIMIT) {
      return this.formatCountStatus(completed, running, failed);
    }

    // Progressive names for small overflow
    return this.formatProgressiveStatus(state.condensedTools);
  }

  /**
   * Format status with count totals
   */
  private formatCountStatus(completed: number, running: number, failed: number): string {
    const parts: string[] = [];

    if (completed > 0) {
      parts.push(`${completed} completed`);
    }
    if (running > 0) {
      parts.push(`${running} running`);
    }
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }

    return parts.length > 0 ? parts.join(', ') : '0 tools';
  }

  /**
   * Format status with progressive tool names
   */
  private formatProgressiveStatus(condensedTools: CondensedToolCall[]): string {
    const names = condensedTools.map((t) => {
      const statusIcon = t.status === 'completed' ? ' ✓' : t.status === 'failed' ? ' ✗' : '';
      return `${t.toolName}${statusIcon}`;
    });

    const hasRunning = condensedTools.some(
      (t) => t.status === 'in_progress' || t.status === 'pending'
    );

    const suffix = hasRunning ? ' running...' : '';

    return `+ ${names.join(', ')}${suffix}`;
  }

  /**
   * Set status message ID for updates
   *
   * @param sessionId - Session ID
   * @param channelId - Channel ID
   * @param messageId - Discord message ID for status
   */
  setStatusMessageId(sessionId: string, channelId: string, messageId: string): void {
    const key = this.buildKey(sessionId, channelId);
    const state = this.displayStates.get(key);

    if (state) {
      state.statusMessageId = messageId;
      this.logger.debug('Set status message ID', { sessionId, channelId, messageId });
    }
  }

  /**
   * Get status message ID
   *
   * @param sessionId - Session ID
   * @param channelId - Channel ID
   * @returns Status message ID or null
   */
  getStatusMessageId(sessionId: string, channelId: string): string | null {
    const key = this.buildKey(sessionId, channelId);
    return this.displayStates.get(key)?.statusMessageId ?? null;
  }

  /**
   * Get display state (for testing/debugging)
   *
   * @param sessionId - Session ID
   * @param channelId - Channel ID
   * @returns Display state or undefined
   */
  getState(sessionId: string, channelId: string): CondensedDisplayState | undefined {
    const key = this.buildKey(sessionId, channelId);
    return this.displayStates.get(key);
  }

  /**
   * Clean up tracking for a session
   *
   * @param sessionId - Session ID to clean up
   */
  cleanupSession(sessionId: string): void {
    const keysToDelete: string[] = [];

    for (const [key, state] of this.displayStates.entries()) {
      if (state.sessionId === sessionId) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.displayStates.delete(key);
    }

    this.logger.debug('Session cleanup complete', {
      sessionId,
      statesRemoved: keysToDelete.length,
    });
  }

  /**
   * Build composite key for state lookup
   */
  private buildKey(sessionId: string, channelId: string): string {
    return `${sessionId}:${channelId}`;
  }
}
