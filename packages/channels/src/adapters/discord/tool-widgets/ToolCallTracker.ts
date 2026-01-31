/**
 * ToolCallTracker - Tracks active tool calls and their Discord message mappings
 *
 * Maintains state for:
 * - Tool call ID -> Discord message mapping
 * - Multiple widgets per message (up to 10 embeds)
 * - Session isolation
 * - Widget rebuild for message edits
 *
 * @see @discord-tool-widgets
 */

import { createLogger } from '@kynetic-bot/core';
import type { EmbedBuilder, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import type { ToolCall, ToolCallUpdate } from '@kynetic-bot/agent';
import type { WidgetResult, ToolWidgetBuilder } from './ToolWidgetBuilder.js';
import type { MessageUpdateBatcher } from './MessageUpdateBatcher.js';

const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_ACTION_ROWS_PER_MESSAGE = 5; // Discord API limit

/**
 * Tool call state tracking
 */
export interface ToolCallState {
  toolCallId: string;
  messageId: string;
  channelId: string;
  sessionId: string;
  embedIndex: number;
  status?: string;
  widgetResult: WidgetResult;
  toolCall: ToolCall;
  update?: ToolCallUpdate;
}

/**
 * Message state with multiple embeds
 */
export interface MessageState {
  messageId: string;
  channelId: string;
  sessionId: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  toolCallIds: string[];
}

/**
 * ToolCallTracker - Tracks tool calls and Discord message mappings
 */
export class ToolCallTracker {
  private readonly logger = createLogger('tool-call-tracker');
  private readonly toolCallStates = new Map<string, ToolCallState>();
  private readonly messageStates = new Map<string, MessageState>();
  private readonly batcher: MessageUpdateBatcher;
  private readonly widgetBuilder: ToolWidgetBuilder;

  constructor(batcher: MessageUpdateBatcher, widgetBuilder: ToolWidgetBuilder) {
    this.batcher = batcher;
    this.widgetBuilder = widgetBuilder;
  }

  /**
   * Track a new tool call
   *
   * AC: @discord-tool-widgets ac-1
   *
   * @param toolCall - Tool call to track
   * @param sessionId - Session ID for isolation
   * @param channelId - Discord channel ID
   * @param widgetResult - Widget build result
   * @returns Message ID where widget was placed
   */
  async trackToolCall(
    toolCall: ToolCall,
    sessionId: string,
    channelId: string,
    widgetResult: WidgetResult,
    sendMessage: (
      embeds: EmbedBuilder[],
      components: ActionRowBuilder<ButtonBuilder>[]
    ) => Promise<string>
  ): Promise<string> {
    const toolCallId = toolCall.toolCallId;

    // Check if we need to create a new message or can append to existing
    const existingMessage = this.findMessageWithSpace(sessionId, channelId);

    let messageId: string;
    let embedIndex: number;

    if (existingMessage) {
      // Append to existing message
      messageId = existingMessage.messageId;
      embedIndex = existingMessage.embeds.length;

      existingMessage.embeds.push(widgetResult.embed);
      existingMessage.components.push(...widgetResult.components);
      existingMessage.toolCallIds.push(toolCallId);

      // Queue update to Discord (enforce ActionRow limit)
      await this.batcher.queueUpdate(
        messageId,
        channelId,
        existingMessage.embeds,
        existingMessage.components.slice(0, MAX_ACTION_ROWS_PER_MESSAGE)
      );
    } else {
      // Create new message
      messageId = await sendMessage([widgetResult.embed], widgetResult.components);
      embedIndex = 0;

      this.messageStates.set(messageId, {
        messageId,
        channelId,
        sessionId,
        embeds: [widgetResult.embed],
        components: widgetResult.components,
        toolCallIds: [toolCallId],
      });
    }

    // Track tool call state
    this.toolCallStates.set(toolCallId, {
      toolCallId,
      messageId,
      channelId,
      sessionId,
      embedIndex,
      status: toolCall.status || undefined,
      widgetResult,
      toolCall,
    });

    this.logger.debug('Tracked tool call', { toolCallId, messageId, embedIndex });

    return messageId;
  }

  /**
   * Update an existing tool call widget
   *
   * AC: @discord-tool-widgets ac-2, ac-3, ac-5, ac-6
   *
   * @param toolCallId - Tool call ID to update
   * @param update - Tool call update
   * @param newWidgetResult - New widget build result
   */
  async updateToolCall(
    toolCallId: string,
    update: ToolCallUpdate,
    newWidgetResult: WidgetResult
  ): Promise<void> {
    const state = this.toolCallStates.get(toolCallId);

    if (!state) {
      this.logger.warn('Tool call not found for update', { toolCallId });
      return;
    }

    // Update tool call state
    state.status = update.status || undefined;
    state.update = update;
    state.widgetResult = newWidgetResult;

    // Get message state
    const messageState = this.messageStates.get(state.messageId);

    if (!messageState) {
      this.logger.error('Message state not found', {
        toolCallId,
        messageId: state.messageId,
      });
      return;
    }

    // Update embed at the specific index
    messageState.embeds[state.embedIndex] = newWidgetResult.embed;

    // Rebuild all components from all tool calls in this message
    // Each tool call stores its widgetResult, which contains components
    messageState.components = messageState.toolCallIds
      .map((id) => this.toolCallStates.get(id)?.widgetResult.components ?? [])
      .flat()
      .slice(0, MAX_ACTION_ROWS_PER_MESSAGE);

    // Queue update through batcher (handles rate limiting)
    // AC-5: MessageUpdateBatcher batches rapid updates
    await this.batcher.queueUpdate(
      state.messageId,
      state.channelId,
      messageState.embeds,
      messageState.components
    );

    this.logger.debug('Updated tool call widget', {
      toolCallId,
      messageId: state.messageId,
      embedIndex: state.embedIndex,
      status: update.status,
    });
  }

  /**
   * Get full output for a tool call (for expand button)
   *
   * AC: @discord-tool-widgets ac-4
   *
   * @param toolCallId - Tool call ID
   * @returns Full output string or null if not available
   */
  getFullOutput(toolCallId: string): string | null {
    const state = this.toolCallStates.get(toolCallId);

    if (!state) {
      return null;
    }

    // Get full output from rawOutput
    if (state.toolCall.rawOutput) {
      return typeof state.toolCall.rawOutput === 'string'
        ? state.toolCall.rawOutput
        : JSON.stringify(state.toolCall.rawOutput);
    }

    // Get from content
    if (state.toolCall.content && state.toolCall.content.length > 0) {
      return state.toolCall.content
        .map((c: { type?: string; text?: string; diff?: string }) => {
          if (c.type === 'content' && c.text) return c.text;
          if (c.type === 'diff' && c.diff) return c.diff;
          return JSON.stringify(c);
        })
        .join('\n');
    }

    return null;
  }

  /**
   * Clean up tracking for a session
   *
   * Updates widgets to final state (completed/failed) and removes expand buttons,
   * then clears tracking state.
   *
   * AC: @discord-tool-widgets ac-9
   *
   * @param sessionId - Session ID to clean up
   */
  async cleanupSession(sessionId: string): Promise<void> {
    this.logger.info('Cleaning up session', { sessionId });

    // Find all messages for this session that need final updates
    const messagesToUpdate = new Map<string, MessageState>();
    const toolCallsToCleanup: string[] = [];

    for (const [toolCallId, state] of this.toolCallStates.entries()) {
      if (state.sessionId === sessionId) {
        toolCallsToCleanup.push(toolCallId);

        const messageState = this.messageStates.get(state.messageId);
        if (messageState) {
          messagesToUpdate.set(state.messageId, messageState);

          // Update widget to final state (no expand button)
          const finalWidget = this.buildFinalWidget(state);
          state.widgetResult = finalWidget;
          messageState.embeds[state.embedIndex] = finalWidget.embed;
        }
      }
    }

    // Queue final updates for each message (remove all buttons)
    for (const [messageId, messageState] of messagesToUpdate) {
      // Clear all components since session is ending
      messageState.components = [];

      await this.batcher.queueUpdate(
        messageId,
        messageState.channelId,
        messageState.embeds,
        messageState.components
      );
    }

    // Now clear tracking state
    for (const toolCallId of toolCallsToCleanup) {
      this.toolCallStates.delete(toolCallId);
    }

    // Find and remove message states
    const messagesToRemove: string[] = [];

    for (const [messageId, state] of this.messageStates.entries()) {
      if (state.sessionId === sessionId) {
        messagesToRemove.push(messageId);
      }
    }

    for (const messageId of messagesToRemove) {
      this.messageStates.delete(messageId);
    }

    this.logger.debug('Session cleanup complete', {
      sessionId,
      toolCallsCleaned: toolCallsToCleanup.length,
      messagesCleaned: messagesToRemove.length,
    });
  }

  /**
   * Build a final widget (no expand button) for session cleanup
   */
  private buildFinalWidget(state: ToolCallState): WidgetResult {
    // Determine final status - preserve failed status, otherwise mark as completed
    const finalStatus = state.status === 'failed' ? 'failed' : 'completed';

    // Build widget with final status
    const widget = this.widgetBuilder.buildWidget(state.toolCall, {
      status: finalStatus,
    } as import('@kynetic-bot/agent').ToolCallUpdate);

    // Return widget without components (no expand button after session ends)
    return {
      ...widget,
      components: [],
      hasExpandButton: false,
    };
  }

  /**
   * Find a message with space for more embeds
   *
   * AC: @discord-tool-widgets ac-7
   */
  private findMessageWithSpace(sessionId: string, channelId: string): MessageState | undefined {
    for (const messageState of this.messageStates.values()) {
      if (
        messageState.sessionId === sessionId &&
        messageState.channelId === channelId &&
        messageState.embeds.length < MAX_EMBEDS_PER_MESSAGE
      ) {
        return messageState;
      }
    }

    return undefined;
  }

  /**
   * Get all tracked tool calls (for debugging/testing)
   */
  getAllToolCalls(): ToolCallState[] {
    return Array.from(this.toolCallStates.values());
  }

  /**
   * Get all message states (for debugging/testing)
   */
  getAllMessages(): MessageState[] {
    return Array.from(this.messageStates.values());
  }
}
