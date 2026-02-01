/**
 * TurnReconstructor Tests
 *
 * Tests for reconstructing turn content from session events.
 *
 * @see @mem-conversation ac-4, ac-5
 * @see @mem-turn-reconstruct
 */

import { EventEmitter } from 'events';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  TurnReconstructor,
  TurnReconstructorValidationError,
  type TurnReconstructorLogger,
} from '../src/store/turn-reconstructor.js';
import type { SessionStore } from '../src/store/session-store.js';
import type { SessionEvent } from '../src/types/session.js';

describe('TurnReconstructor', () => {
  let mockSessionStore: {
    readEvents: ReturnType<typeof vi.fn>;
  };
  let mockLogger: TurnReconstructorLogger;
  let reconstructor: TurnReconstructor;

  beforeEach(() => {
    mockSessionStore = {
      readEvents: vi.fn().mockResolvedValue([]),
    };
    mockLogger = {
      warn: vi.fn(),
    };
    reconstructor = new TurnReconstructor(mockSessionStore as unknown as SessionStore, {
      logger: mockLogger,
    });
  });

  describe('reconstructContent', () => {
    // AC: @mem-conversation ac-4 - Content reconstructed from events via TurnReconstructor
    it('reconstructs content from prompt.sent event', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: { content: 'Hello, how are you?' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('Hello, how are you?');
      expect(result.hasGaps).toBe(false);
      expect(result.eventsRead).toBe(1);
      expect(result.eventsMissing).toBe(0);
    });

    it('reconstructs content from message.chunk events', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'Hello, ' },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'how are ' },
        },
        {
          ts: Date.now(),
          seq: 2,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'you?' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 2,
      });

      expect(result.content).toBe('Hello, how are you?');
      expect(result.hasGaps).toBe(false);
      expect(result.eventsRead).toBe(3);
    });

    it('reconstructs content from session.update events (agent_message_chunk)', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'agent_message_chunk',
            payload: { content: { text: 'I am doing well!' } },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('I am doing well!');
      expect(result.hasGaps).toBe(false);
    });

    it('combines multiple session.update chunks', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'agent_message_chunk',
            payload: { content: { text: 'Part 1. ' } },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'agent_message_chunk',
            payload: { content: { text: 'Part 2.' } },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(result.content).toBe('Part 1. Part 2.');
    });

    it('ignores non-content session.update types', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_use',
            payload: { tool_name: 'calculator' },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'agent_message_chunk',
            payload: { content: { text: 'Result: 42' } },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      // Only the message chunk contributes content
      expect(result.content).toBe('Result: 42');
    });

    it('ignores non-text events like tool.call and tool.result', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: { content: 'Calculate 2+2' },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.call',
          session_id: '01SESSION',
          data: { tool_name: 'calculator', arguments: { a: 2, b: 2 } },
        },
        {
          ts: Date.now(),
          seq: 2,
          type: 'tool.result',
          session_id: '01SESSION',
          data: { tool_name: 'calculator', success: true, result: 4 },
        },
        {
          ts: Date.now(),
          seq: 3,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'The answer is 4' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 3,
      });

      expect(result.content).toBe('Calculate 2+2The answer is 4');
      expect(result.hasGaps).toBe(false);
    });

    // AC: @mem-conversation ac-5 - Returns partial content with [gap] markers
    it('marks gaps when events are missing', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'Start' },
        },
        // seq 1 and 2 missing
        {
          ts: Date.now(),
          seq: 3,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'End' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 3,
      });

      expect(result.content).toBe('Start[gap: events 1-2 missing]End');
      expect(result.hasGaps).toBe(true);
      expect(result.eventsRead).toBe(2);
      expect(result.eventsMissing).toBe(2);
    });

    it('marks gap at the beginning', async () => {
      const events: SessionEvent[] = [
        // seq 0 missing
        {
          ts: Date.now(),
          seq: 1,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'Content' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(result.content).toBe('[gap: events 0-0 missing]Content');
      expect(result.hasGaps).toBe(true);
    });

    it('marks gap at the end', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'Content' },
        },
        // seq 1 and 2 missing
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 2,
      });

      expect(result.content).toBe('Content[gap: events 1-2 missing]');
      expect(result.hasGaps).toBe(true);
    });

    it('handles all events missing', async () => {
      mockSessionStore.readEvents.mockResolvedValue([]);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 5,
      });

      expect(result.content).toBe('[gap: all events missing]');
      expect(result.hasGaps).toBe(true);
      expect(result.eventsRead).toBe(0);
      expect(result.eventsMissing).toBe(6);
    });

    it('logs warning when gaps detected', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'Content' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 2,
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Event gap detected during reconstruction',
        expect.objectContaining({
          sessionId: '01SESSION',
          expectedCount: 3,
          actualCount: 1,
        })
      );
    });

    it('handles single event range', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 5,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: { content: 'Single message' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 5,
        end_seq: 5,
      });

      expect(result.content).toBe('Single message');
      expect(result.hasGaps).toBe(false);
      expect(result.eventsRead).toBe(1);
    });

    it('handles missing content field in event data', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: {}, // Missing content
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('');
      expect(result.hasGaps).toBe(false);
    });
  });

  describe('getContent', () => {
    it('returns just the content string', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: { content: 'Hello!' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const content = await reconstructor.getContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(content).toBe('Hello!');
    });
  });

  describe('input validation', () => {
    // AC: @mem-turn-reconstruct ac-5
    it('throws TurnReconstructorValidationError for empty session_id', async () => {
      await expect(
        reconstructor.reconstructContent('', { start_seq: 0, end_seq: 0 })
      ).rejects.toThrow(TurnReconstructorValidationError);
    });

    // AC: @mem-turn-reconstruct ac-5
    it('error includes field="session_id" for empty session_id', async () => {
      try {
        await reconstructor.reconstructContent('', { start_seq: 0, end_seq: 0 });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TurnReconstructorValidationError);
        expect((error as TurnReconstructorValidationError).field).toBe('session_id');
      }
    });

    // AC: @mem-turn-reconstruct ac-6
    it('throws TurnReconstructorValidationError when start_seq > end_seq', async () => {
      await expect(
        reconstructor.reconstructContent('01SESSION', { start_seq: 5, end_seq: 3 })
      ).rejects.toThrow(TurnReconstructorValidationError);
    });

    // AC: @mem-turn-reconstruct ac-6
    it('error includes field="event_range" for invalid range', async () => {
      try {
        await reconstructor.reconstructContent('01SESSION', { start_seq: 5, end_seq: 3 });
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TurnReconstructorValidationError);
        expect((error as TurnReconstructorValidationError).field).toBe('event_range');
      }
    });

    it('accepts equal start_seq and end_seq', async () => {
      mockSessionStore.readEvents.mockResolvedValue([
        {
          ts: Date.now(),
          seq: 5,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: { content: 'Test' },
        },
      ]);

      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 5,
        end_seq: 5,
      });

      expect(result.content).toBe('Test');
    });
  });

  describe('event emission', () => {
    let mockEmitter: EventEmitter;
    let emitterReconstructor: TurnReconstructor;

    beforeEach(() => {
      mockEmitter = new EventEmitter();
      emitterReconstructor = new TurnReconstructor(mockSessionStore as unknown as SessionStore, {
        logger: mockLogger,
        emitter: mockEmitter,
      });
    });

    // AC: @mem-turn-reconstruct ac-3
    it('emits reconstruction:completed with stats', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: { content: 'Hello' },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'World' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const emitHandler = vi.fn();
      mockEmitter.on('reconstruction:completed', emitHandler);

      await emitterReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(emitHandler).toHaveBeenCalledWith({
        sessionId: '01SESSION',
        eventRange: { start_seq: 0, end_seq: 1 },
        eventsRead: 2,
        eventsMissing: 0,
        hasGaps: false,
      });
    });

    // AC: @mem-turn-reconstruct ac-3
    it('event includes gap information', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: { content: 'Start' },
        },
        // seq 1 missing
        {
          ts: Date.now(),
          seq: 2,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'End' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const emitHandler = vi.fn();
      mockEmitter.on('reconstruction:completed', emitHandler);

      await emitterReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 2,
      });

      expect(emitHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          eventsRead: 2,
          eventsMissing: 1,
          hasGaps: true,
        })
      );
    });

    it('does not throw when no emitter configured', async () => {
      // Use the reconstructor without emitter
      mockSessionStore.readEvents.mockResolvedValue([
        {
          ts: Date.now(),
          seq: 0,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: { content: 'Test' },
        },
      ]);

      // Should not throw
      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('Test');
    });
  });

  describe('tool summarization', () => {
    let toolReconstructor: TurnReconstructor;

    beforeEach(() => {
      toolReconstructor = new TurnReconstructor(mockSessionStore as unknown as SessionStore, {
        logger: mockLogger,
        summarizeTools: true,
      });
    });

    // AC: @mem-turn-reconstruct ac-4
    it('summarizes read tool with line count', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'read',
            call_id: 'call-1',
            arguments: { file_path: '/src/index.ts' },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.result',
          session_id: '01SESSION',
          data: {
            call_id: 'call-1',
            success: true,
            result: 'line1\nline2\nline3\nline4\nline5',
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(result.content).toBe('[tool: read | /src/index.ts | success | 5 lines]');
    });

    // AC: @mem-turn-reconstruct ac-4
    it('summarizes bash tool with exit code', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'bash',
            call_id: 'call-1',
            arguments: { command: 'npm test' },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.result',
          session_id: '01SESSION',
          data: {
            call_id: 'call-1',
            success: false,
            result: { exit_code: 1 },
            error: 'Tests failed',
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(result.content).toBe('[tool: bash | npm test | failure | Tests failed]');
    });

    // AC: @mem-turn-reconstruct ac-4
    it('summarizes write tool', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'write',
            call_id: 'call-1',
            arguments: { file_path: '/src/new-file.ts' },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.result',
          session_id: '01SESSION',
          data: {
            call_id: 'call-1',
            success: true,
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(result.content).toBe('[tool: write | /src/new-file.ts | success]');
    });

    // AC: @mem-turn-reconstruct ac-4
    it('combines text and tool summaries', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: { content: 'Read the file.' },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'read',
            call_id: 'call-1',
            arguments: { file_path: '/src/index.ts' },
          },
        },
        {
          ts: Date.now(),
          seq: 2,
          type: 'tool.result',
          session_id: '01SESSION',
          data: {
            call_id: 'call-1',
            success: true,
            result: 'content',
          },
        },
        {
          ts: Date.now(),
          seq: 3,
          type: 'message.chunk',
          session_id: '01SESSION',
          data: { content: 'Done!' },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 3,
      });

      expect(result.content).toBe(
        'Read the file.[tool: read | /src/index.ts | success | 1 lines]Done!'
      );
    });

    // AC: @mem-turn-reconstruct ac-4
    it('does not summarize tools when option disabled (default)', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'read',
            call_id: 'call-1',
            arguments: { file_path: '/src/index.ts' },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.result',
          session_id: '01SESSION',
          data: {
            call_id: 'call-1',
            success: true,
            result: 'content',
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      // Use default reconstructor (summarizeTools = false)
      const result = await reconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      // Tool events ignored
      expect(result.content).toBe('');
    });

    // AC: @mem-turn-reconstruct ac-7
    it('truncates long file paths from start', async () => {
      // Path must be > 100 chars to trigger truncation
      const longPath =
        '/home/user/projects/kynetic-bot/packages/memory/src/store/very-long-path-name/deeply/nested/directory/structure/file.ts';
      expect(longPath.length).toBeGreaterThan(100); // Sanity check
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'read',
            call_id: 'call-1',
            arguments: { file_path: longPath },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.result',
          session_id: '01SESSION',
          data: {
            call_id: 'call-1',
            success: true,
            result: 'x',
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      // Should truncate from start (keeping filename visible)
      expect(result.content).toContain('...');
      expect(result.content).toContain('file.ts');
      // Input should be max 100 chars
      const match = result.content.match(/\| ([^|]+) \| success/);
      expect(match?.[1]?.trim().length).toBeLessThanOrEqual(100);
    });

    // AC: @mem-turn-reconstruct ac-7
    it('truncates long bash commands from end', async () => {
      const longCommand = 'npm run build && npm run test && npm run lint && ' + 'x'.repeat(100);
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'bash',
            call_id: 'call-1',
            arguments: { command: longCommand },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.result',
          session_id: '01SESSION',
          data: {
            call_id: 'call-1',
            success: true,
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      // Should truncate from end
      expect(result.content).toContain('npm run build');
      expect(result.content).toContain('...');
    });

    // AC: @mem-turn-reconstruct ac-7
    it('adds ellipsis when truncated', async () => {
      const longPath = '/very/long/path/' + 'a'.repeat(150) + '/file.ts';
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'read',
            call_id: 'call-1',
            arguments: { file_path: longPath },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.result',
          session_id: '01SESSION',
          data: {
            call_id: 'call-1',
            success: true,
            result: 'x',
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(result.content).toContain('...');
    });

    // AC: @mem-turn-reconstruct ac-8
    it('shows pending for tool.call without result', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'read',
            call_id: 'call-1',
            arguments: { file_path: '/src/index.ts' },
          },
        },
        // No matching tool.result
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('[tool: read | /src/index.ts | pending]');
    });

    it('handles malformed tool data gracefully', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            // Missing tool_name
            call_id: 'call-1',
            arguments: {},
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      // Should skip malformed event
      expect(result.content).toBe('');
      expect(mockLogger.warn).toHaveBeenCalledWith('tool.call event missing tool_name', {
        seq: 0,
      });
    });

    it('matches tool results by trace_id fallback', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'read',
            trace_id: 'trace-1', // No call_id, use trace_id
            arguments: { file_path: '/src/index.ts' },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.result',
          session_id: '01SESSION',
          data: {
            trace_id: 'trace-1', // Match by trace_id
            success: true,
            result: 'line1\nline2',
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(result.content).toBe('[tool: read | /src/index.ts | success | 2 lines]');
    });

    it('summarizes grep tool with match count', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'tool.call',
          session_id: '01SESSION',
          data: {
            tool_name: 'grep',
            call_id: 'call-1',
            arguments: { pattern: 'TODO', path: '/src' },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'tool.result',
          session_id: '01SESSION',
          data: {
            call_id: 'call-1',
            success: true,
            result: 'file1.ts:10: TODO fix this\nfile2.ts:20: TODO later\nfile3.ts:5: TODO now',
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(result.content).toBe('[tool: grep | TODO in /src | success | 3 matches]');
    });
  });

  // AC: @mem-turn-reconstruct ac-9 - ACP session.update tool_call/tool_call_update handling
  describe('session.update tool_call events', () => {
    let toolReconstructor: TurnReconstructor;

    beforeEach(() => {
      toolReconstructor = new TurnReconstructor(mockSessionStore as unknown as SessionStore, {
        logger: mockLogger,
        summarizeTools: true,
      });
    });

    it('summarizes session.update tool_call events with MCP tool name', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              toolCallId: 'tc-1',
              title: 'Read /src/index.ts',
              kind: 'read',
              rawInput: { file_path: '/src/index.ts' },
              status: 'pending',
              _meta: { claudeCode: { toolName: 'mcp__acp__Read' } },
            },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call_update',
            payload: {
              toolCallId: 'tc-1',
              status: 'completed',
              rawOutput: [{ type: 'text', text: 'line1\nline2\nline3' }],
            },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(result.content).toBe('[tool: read | /src/index.ts | success | 3 lines]');
    });

    it('extracts tool name from MCP tool name format', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              toolCallId: 'tc-1',
              title: 'Terminal',
              kind: 'execute',
              rawInput: { command: 'npm test' },
              status: 'completed',
              _meta: { claudeCode: { toolName: 'mcp__acp__Bash' } },
            },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('[tool: bash | npm test | success]');
    });

    it('shows pending status when no update event exists', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              toolCallId: 'tc-1',
              title: 'Read /src/index.ts',
              kind: 'read',
              status: 'pending',
              _meta: { claudeCode: { toolName: 'mcp__acp__Read' } },
            },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('[tool: read | /src/index.ts | pending]');
    });

    it('shows failure status from tool_call_update', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              toolCallId: 'tc-1',
              title: 'Terminal',
              kind: 'execute',
              rawInput: { command: 'npm test' },
              status: 'pending',
              _meta: { claudeCode: { toolName: 'mcp__acp__Bash' } },
            },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call_update',
            payload: {
              toolCallId: 'tc-1',
              status: 'failed',
            },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      expect(result.content).toBe('[tool: bash | npm test | failure | Tool call failed]');
    });

    it('combines text and session.update tool calls', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'prompt.sent',
          session_id: '01SESSION',
          data: { content: 'Read the file.' },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              toolCallId: 'tc-1',
              title: 'Read /src/index.ts',
              kind: 'read',
              rawInput: { file_path: '/src/index.ts' },
              status: 'pending',
              _meta: { claudeCode: { toolName: 'mcp__acp__Read' } },
            },
          },
        },
        {
          ts: Date.now(),
          seq: 2,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call_update',
            payload: {
              toolCallId: 'tc-1',
              status: 'completed',
              rawOutput: [{ type: 'text', text: 'content' }],
            },
          },
        },
        {
          ts: Date.now(),
          seq: 3,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'agent_message_chunk',
            payload: { content: { text: 'Done!' } },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 3,
      });

      expect(result.content).toBe(
        'Read the file.[tool: read | /src/index.ts | success | 1 lines]Done!'
      );
    });

    it('does not summarize session.update tool_call when summarizeTools is false', async () => {
      const noToolReconstructor = new TurnReconstructor(
        mockSessionStore as unknown as SessionStore,
        {
          logger: mockLogger,
          summarizeTools: false,
        }
      );

      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              toolCallId: 'tc-1',
              title: 'Read /src/index.ts',
              kind: 'read',
              status: 'completed',
              _meta: { claudeCode: { toolName: 'mcp__acp__Read' } },
            },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await noToolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('');
    });

    it('handles session.update tool_call with no rawOutput on completion', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              toolCallId: 'tc-1',
              title: 'Write /src/new-file.ts',
              kind: 'write',
              rawInput: { file_path: '/src/new-file.ts' },
              status: 'completed',
              _meta: { claudeCode: { toolName: 'mcp__acp__Write' } },
            },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('[tool: write | /src/new-file.ts | success]');
    });

    it('falls back to kind when no MCP tool name or title prefix', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              toolCallId: 'tc-1',
              title: 'Custom operation',
              kind: 'execute',
              rawInput: { command: 'echo hello' },
              status: 'completed',
            },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('[tool: bash | echo hello | success]');
    });

    it('warns and returns empty string when toolCallId is missing', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              title: 'Read /src/index.ts',
              // toolCallId is missing
            },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('');
      expect(mockLogger.warn).toHaveBeenCalledWith('session.update tool_call missing toolCallId', {
        seq: 0,
      });
    });

    it('extracts input from title when rawInput is empty', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              toolCallId: 'tc-1',
              title: 'Read /src/index.ts',
              kind: 'read',
              rawInput: {},
              status: 'completed',
              _meta: { claudeCode: { toolName: 'mcp__acp__Read' } },
            },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 0,
      });

      expect(result.content).toBe('[tool: read | /src/index.ts | success]');
    });

    it('handles rawOutput as array of content blocks', async () => {
      const events: SessionEvent[] = [
        {
          ts: Date.now(),
          seq: 0,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call',
            payload: {
              toolCallId: 'tc-1',
              title: 'Read /src/index.ts',
              kind: 'read',
              rawInput: { file_path: '/src/index.ts' },
              status: 'pending',
              _meta: { claudeCode: { toolName: 'mcp__acp__Read' } },
            },
          },
        },
        {
          ts: Date.now(),
          seq: 1,
          type: 'session.update',
          session_id: '01SESSION',
          data: {
            update_type: 'tool_call_update',
            payload: {
              toolCallId: 'tc-1',
              status: 'completed',
              rawOutput: [
                { type: 'text', text: 'Line 1' },
                { type: 'text', text: 'Line 2\nLine 3' },
              ],
            },
          },
        },
      ];
      mockSessionStore.readEvents.mockResolvedValue(events);

      const result = await toolReconstructor.reconstructContent('01SESSION', {
        start_seq: 0,
        end_seq: 1,
      });

      // Combined output: "Line 1\nLine 2\nLine 3" = 3 lines
      expect(result.content).toBe('[tool: read | /src/index.ts | success | 3 lines]');
    });
  });
});
