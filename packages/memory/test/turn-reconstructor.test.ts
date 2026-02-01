/**
 * TurnReconstructor Tests
 *
 * Tests for reconstructing turn content from session events.
 *
 * @see @mem-conversation ac-4, ac-5
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  TurnReconstructor,
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
});
