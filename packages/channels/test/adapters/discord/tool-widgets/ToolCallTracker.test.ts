/**
 * ToolCallTracker Tests
 *
 * Tests for tracking tool calls and their Discord message mappings.
 * AC: @discord-tool-widgets ac-1, ac-2, ac-7, ac-9
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { ToolCallTracker } from '../../../../src/adapters/discord/tool-widgets/ToolCallTracker.js';
import { MessageUpdateBatcher } from '../../../../src/adapters/discord/tool-widgets/MessageUpdateBatcher.js';
import type { ToolCall, ToolCallUpdate } from '@kynetic-bot/agent';
import type { WidgetResult } from '../../../../src/adapters/discord/tool-widgets/ToolWidgetBuilder.js';

/**
 * Create a mock ToolCall
 */
function createMockToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test Tool',
    kind: 'file',
    status: 'in_progress',
    ...overrides,
  } as ToolCall;
}

/**
 * Create a mock WidgetResult
 */
function createMockWidgetResult(): WidgetResult {
  return {
    embed: new EmbedBuilder().setTitle('Test'),
    components: [],
    hasExpandButton: false,
  };
}

/**
 * Create a mock MessageUpdateBatcher
 */
function createMockBatcher() {
  return {
    queueUpdate: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getQueueSize: vi.fn().mockReturnValue(0),
    getTokens: vi.fn().mockReturnValue(5),
  } as unknown as MessageUpdateBatcher;
}

/**
 * Create a mock sendMessage function
 */
function createMockSendMessage() {
  let messageCounter = 0;
  return vi.fn().mockImplementation(() => {
    return Promise.resolve(`msg-${++messageCounter}`);
  });
}

describe('ToolCallTracker', () => {
  let tracker: ToolCallTracker;
  let batcher: ReturnType<typeof createMockBatcher>;

  beforeEach(() => {
    batcher = createMockBatcher();
    tracker = new ToolCallTracker(batcher as MessageUpdateBatcher);
  });

  describe('trackToolCall()', () => {
    // AC: @discord-tool-widgets ac-1 - Track tool calls
    it('should track a new tool call and return message ID', async () => {
      const toolCall = createMockToolCall({ toolCallId: 'tc-1' });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      const messageId = await tracker.trackToolCall(
        toolCall,
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      expect(messageId).toBe('msg-1');
      expect(sendMessage).toHaveBeenCalledWith([widgetResult.embed], widgetResult.components);
    });

    it('should store tool call state', async () => {
      const toolCall = createMockToolCall({ toolCallId: 'tc-1' });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      await tracker.trackToolCall(toolCall, 'session-1', 'channel-1', widgetResult, sendMessage);

      const allToolCalls = tracker.getAllToolCalls();
      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0]).toMatchObject({
        toolCallId: 'tc-1',
        sessionId: 'session-1',
        channelId: 'channel-1',
        embedIndex: 0,
      });
    });

    // AC: @discord-tool-widgets ac-7 - Multiple embeds per message
    it('should append to existing message if space available', async () => {
      const toolCall1 = createMockToolCall({ toolCallId: 'tc-1' });
      const toolCall2 = createMockToolCall({ toolCallId: 'tc-2' });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      const messageId1 = await tracker.trackToolCall(
        toolCall1,
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      const messageId2 = await tracker.trackToolCall(
        toolCall2,
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      // Same message should be used
      expect(messageId1).toBe(messageId2);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // Batcher should queue an update for the second tool call
      expect(batcher.queueUpdate).toHaveBeenCalled();

      // Check embed indices
      const allToolCalls = tracker.getAllToolCalls();
      expect(allToolCalls[0]!.embedIndex).toBe(0);
      expect(allToolCalls[1]!.embedIndex).toBe(1);
    });

    it('should create new message for different session', async () => {
      const toolCall1 = createMockToolCall({ toolCallId: 'tc-1' });
      const toolCall2 = createMockToolCall({ toolCallId: 'tc-2' });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      const messageId1 = await tracker.trackToolCall(
        toolCall1,
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      const messageId2 = await tracker.trackToolCall(
        toolCall2,
        'session-2', // Different session
        'channel-1',
        widgetResult,
        sendMessage
      );

      expect(messageId1).not.toBe(messageId2);
      expect(sendMessage).toHaveBeenCalledTimes(2);
    });

    it('should create new message for different channel', async () => {
      const toolCall1 = createMockToolCall({ toolCallId: 'tc-1' });
      const toolCall2 = createMockToolCall({ toolCallId: 'tc-2' });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      const messageId1 = await tracker.trackToolCall(
        toolCall1,
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      const messageId2 = await tracker.trackToolCall(
        toolCall2,
        'session-1',
        'channel-2', // Different channel
        widgetResult,
        sendMessage
      );

      expect(messageId1).not.toBe(messageId2);
    });

    it('should create new message when embed limit reached', async () => {
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      // Add 10 tool calls to fill first message
      for (let i = 0; i < 10; i++) {
        await tracker.trackToolCall(
          createMockToolCall({ toolCallId: `tc-${i}` }),
          'session-1',
          'channel-1',
          widgetResult,
          sendMessage
        );
      }

      expect(sendMessage).toHaveBeenCalledTimes(1);

      // 11th should create new message
      const messageId11 = await tracker.trackToolCall(
        createMockToolCall({ toolCallId: 'tc-10' }),
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(messageId11).toBe('msg-2');
    });
  });

  describe('updateToolCall()', () => {
    // AC: @discord-tool-widgets ac-2, ac-3, ac-5, ac-6 - Update widgets
    it('should update existing tool call widget', async () => {
      const toolCall = createMockToolCall({ toolCallId: 'tc-1' });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      await tracker.trackToolCall(toolCall, 'session-1', 'channel-1', widgetResult, sendMessage);

      const update: ToolCallUpdate = { status: 'completed' } as ToolCallUpdate;
      const newWidgetResult = createMockWidgetResult();

      await tracker.updateToolCall('tc-1', update, newWidgetResult);

      expect(batcher.queueUpdate).toHaveBeenCalled();
    });

    it('should update tool call state with new status', async () => {
      const toolCall = createMockToolCall({ toolCallId: 'tc-1', status: 'in_progress' });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      await tracker.trackToolCall(toolCall, 'session-1', 'channel-1', widgetResult, sendMessage);

      const update: ToolCallUpdate = { status: 'completed' } as ToolCallUpdate;
      const newWidgetResult = createMockWidgetResult();

      await tracker.updateToolCall('tc-1', update, newWidgetResult);

      const allToolCalls = tracker.getAllToolCalls();
      expect(allToolCalls[0]!.status).toBe('completed');
    });

    it('should handle update for unknown tool call gracefully', async () => {
      const update: ToolCallUpdate = { status: 'completed' } as ToolCallUpdate;
      const newWidgetResult = createMockWidgetResult();

      // Should not throw
      await tracker.updateToolCall('unknown-tc', update, newWidgetResult);

      expect(batcher.queueUpdate).not.toHaveBeenCalled();
    });
  });

  describe('getFullOutput()', () => {
    // AC: @discord-tool-widgets ac-4 - Expand functionality
    it('should return rawOutput for tracked tool call', async () => {
      const toolCall = createMockToolCall({
        toolCallId: 'tc-1',
        rawOutput: 'Full output content here',
      });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      await tracker.trackToolCall(toolCall, 'session-1', 'channel-1', widgetResult, sendMessage);

      const output = tracker.getFullOutput('tc-1');

      expect(output).toBe('Full output content here');
    });

    it('should stringify non-string rawOutput', async () => {
      const toolCall = createMockToolCall({
        toolCallId: 'tc-1',
        rawOutput: { data: 'value' },
      });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      await tracker.trackToolCall(toolCall, 'session-1', 'channel-1', widgetResult, sendMessage);

      const output = tracker.getFullOutput('tc-1');

      expect(output).toBe('{"data":"value"}');
    });

    it('should return content if no rawOutput', async () => {
      const toolCall = createMockToolCall({
        toolCallId: 'tc-1',
        rawOutput: undefined,
        content: [
          { type: 'content', text: 'Content text' },
          { type: 'diff', diff: '+ added' },
        ],
      });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      await tracker.trackToolCall(toolCall, 'session-1', 'channel-1', widgetResult, sendMessage);

      const output = tracker.getFullOutput('tc-1');

      expect(output).toContain('Content text');
      expect(output).toContain('+ added');
    });

    it('should return null for unknown tool call', () => {
      const output = tracker.getFullOutput('unknown-tc');

      expect(output).toBeNull();
    });

    it('should return null when no output available', async () => {
      const toolCall = createMockToolCall({
        toolCallId: 'tc-1',
        rawOutput: undefined,
        content: undefined,
      });
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      await tracker.trackToolCall(toolCall, 'session-1', 'channel-1', widgetResult, sendMessage);

      const output = tracker.getFullOutput('tc-1');

      expect(output).toBeNull();
    });
  });

  describe('cleanupSession()', () => {
    // AC: @discord-tool-widgets ac-9 - Session cleanup
    it('should remove all tool calls for session', async () => {
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      // Add tool calls for session-1
      await tracker.trackToolCall(
        createMockToolCall({ toolCallId: 'tc-1' }),
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );
      await tracker.trackToolCall(
        createMockToolCall({ toolCallId: 'tc-2' }),
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      // Add tool call for different session
      await tracker.trackToolCall(
        createMockToolCall({ toolCallId: 'tc-3' }),
        'session-2',
        'channel-1',
        widgetResult,
        sendMessage
      );

      await tracker.cleanupSession('session-1');

      const allToolCalls = tracker.getAllToolCalls();
      expect(allToolCalls).toHaveLength(1);
      expect(allToolCalls[0]!.toolCallId).toBe('tc-3');
    });

    it('should remove message states for session', async () => {
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      await tracker.trackToolCall(
        createMockToolCall({ toolCallId: 'tc-1' }),
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      await tracker.trackToolCall(
        createMockToolCall({ toolCallId: 'tc-2' }),
        'session-2',
        'channel-1',
        widgetResult,
        sendMessage
      );

      await tracker.cleanupSession('session-1');

      const allMessages = tracker.getAllMessages();
      expect(allMessages).toHaveLength(1);
      expect(allMessages[0]!.sessionId).toBe('session-2');
    });

    it('should handle cleanup of non-existent session', async () => {
      // Should not throw
      await tracker.cleanupSession('non-existent');

      expect(tracker.getAllToolCalls()).toHaveLength(0);
    });
  });

  describe('getAllToolCalls()', () => {
    it('should return empty array when no tool calls', () => {
      expect(tracker.getAllToolCalls()).toEqual([]);
    });

    it('should return all tracked tool calls', async () => {
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      await tracker.trackToolCall(
        createMockToolCall({ toolCallId: 'tc-1' }),
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      await tracker.trackToolCall(
        createMockToolCall({ toolCallId: 'tc-2' }),
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      const allToolCalls = tracker.getAllToolCalls();
      expect(allToolCalls).toHaveLength(2);
    });
  });

  describe('getAllMessages()', () => {
    it('should return empty array when no messages', () => {
      expect(tracker.getAllMessages()).toEqual([]);
    });

    it('should return all message states', async () => {
      const widgetResult = createMockWidgetResult();
      const sendMessage = createMockSendMessage();

      await tracker.trackToolCall(
        createMockToolCall({ toolCallId: 'tc-1' }),
        'session-1',
        'channel-1',
        widgetResult,
        sendMessage
      );

      await tracker.trackToolCall(
        createMockToolCall({ toolCallId: 'tc-2' }),
        'session-2',
        'channel-1',
        widgetResult,
        sendMessage
      );

      const allMessages = tracker.getAllMessages();
      expect(allMessages).toHaveLength(2);
    });
  });
});
