/**
 * Session Types Tests
 *
 * Tests for agent session and event Zod schemas.
 *
 * @see @mem-agent-sessions
 */

import { describe, expect, it } from 'vitest';
import {
  AgentSessionMetadataSchema,
  AgentSessionStatusSchema,
  MessageChunkDataSchema,
  MessageChunkEventSchema,
  NoteDataSchema,
  NoteEventSchema,
  PromptSentDataSchema,
  PromptSentEventSchema,
  SessionEndDataSchema,
  SessionEndEventSchema,
  SessionEventInputSchema,
  SessionEventSchema,
  SessionEventTypeSchema,
  SessionMetadataInputSchema,
  SessionStartDataSchema,
  SessionStartEventSchema,
  SessionUpdateDataSchema,
  SessionUpdateEventSchema,
  ToolCallDataSchema,
  ToolCallEventSchema,
  ToolResultDataSchema,
  ToolResultEventSchema,
  TypedSessionEventSchema,
} from '../src/types/session.js';

describe('Session Types', () => {
  describe('AgentSessionStatusSchema', () => {
    // AC: @mem-agent-sessions ac-1 - session status values
    it('accepts valid status values', () => {
      expect(AgentSessionStatusSchema.parse('active')).toBe('active');
      expect(AgentSessionStatusSchema.parse('completed')).toBe('completed');
      expect(AgentSessionStatusSchema.parse('abandoned')).toBe('abandoned');
    });

    // AC: @trait-validated ac-1 - invalid input returns structured error
    it('rejects invalid status values', () => {
      const result = AgentSessionStatusSchema.safeParse('invalid');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toBeDefined();
        expect(result.error.issues[0].message).toContain('Invalid enum value');
      }
    });
  });

  describe('SessionEventTypeSchema', () => {
    // AC: @mem-agent-sessions ac-2, ac-3, ac-8 - event types for chunks, tools, and updates
    it('accepts all 8 event types', () => {
      const validTypes = [
        'session.start',
        'session.end',
        'session.update',
        'prompt.sent',
        'message.chunk',
        'tool.call',
        'tool.result',
        'note',
      ];

      for (const type of validTypes) {
        expect(SessionEventTypeSchema.parse(type)).toBe(type);
      }
    });

    // AC: @trait-validated ac-1 - invalid input returns structured error
    it('rejects invalid event types', () => {
      const result = SessionEventTypeSchema.safeParse('invalid.type');
      expect(result.success).toBe(false);
    });
  });

  describe('AgentSessionMetadataSchema', () => {
    const validMetadata = {
      id: '01ABC123XYZ',
      agent_type: 'claude',
      status: 'active' as const,
      started_at: '2026-01-29T10:00:00.000Z',
    };

    // AC: @mem-agent-sessions ac-1 - session.yaml with required fields
    it('validates required fields', () => {
      const result = AgentSessionMetadataSchema.safeParse(validMetadata);
      expect(result.success).toBe(true);
    });

    it('accepts optional fields', () => {
      const withOptional = {
        ...validMetadata,
        conversation_id: 'conv-123',
        session_key: 'discord:guild:channel:user',
        ended_at: '2026-01-29T11:00:00.000Z',
      };
      const result = AgentSessionMetadataSchema.safeParse(withOptional);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.conversation_id).toBe('conv-123');
        expect(result.data.session_key).toBe('discord:guild:channel:user');
        expect(result.data.ended_at).toBe('2026-01-29T11:00:00.000Z');
      }
    });

    // AC: @trait-validated ac-2 - identifies missing required field
    it('rejects missing required fields', () => {
      const missingId = { ...validMetadata, id: undefined };
      const result = AgentSessionMetadataSchema.safeParse(missingId);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('id'))).toBe(true);
      }
    });

    // AC: @trait-validated ac-3 - includes expected type in error
    it('rejects invalid datetime format', () => {
      const invalidDate = { ...validMetadata, started_at: 'not-a-date' };
      const result = AgentSessionMetadataSchema.safeParse(invalidDate);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('started_at'))).toBe(true);
      }
    });

    it('rejects empty strings for required string fields', () => {
      const emptyId = { ...validMetadata, id: '' };
      const result = AgentSessionMetadataSchema.safeParse(emptyId);
      expect(result.success).toBe(false);
    });
  });

  describe('SessionEventSchema', () => {
    const validEvent = {
      ts: Date.now(),
      seq: 0,
      type: 'session.start' as const,
      session_id: '01ABC123',
      data: {},
    };

    // AC: @mem-agent-sessions ac-2 - events have ts and seq
    it('validates event structure with ts and seq', () => {
      const result = SessionEventSchema.safeParse(validEvent);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ts).toBe(validEvent.ts);
        expect(result.data.seq).toBe(0);
      }
    });

    // AC: @mem-agent-sessions ac-3 - correlation via trace_id
    it('accepts optional trace_id for correlation', () => {
      const withTraceId = { ...validEvent, trace_id: 'trace-abc-123' };
      const result = SessionEventSchema.safeParse(withTraceId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.trace_id).toBe('trace-abc-123');
      }
    });

    // AC: @mem-agent-sessions ac-6 - rejects invalid event data
    it('rejects negative sequence numbers', () => {
      const negativeSeq = { ...validEvent, seq: -1 };
      const result = SessionEventSchema.safeParse(negativeSeq);
      expect(result.success).toBe(false);
    });

    it('rejects non-integer timestamps', () => {
      const floatTs = { ...validEvent, ts: 1234.567 };
      const result = SessionEventSchema.safeParse(floatTs);
      expect(result.success).toBe(false);
    });

    it('rejects zero or negative timestamps', () => {
      const zeroTs = { ...validEvent, ts: 0 };
      const result = SessionEventSchema.safeParse(zeroTs);
      expect(result.success).toBe(false);

      const negativeTs = { ...validEvent, ts: -1000 };
      const result2 = SessionEventSchema.safeParse(negativeTs);
      expect(result2.success).toBe(false);
    });

    it('accepts any data payload', () => {
      const withData = { ...validEvent, data: { custom: 'payload', nested: { value: 123 } } };
      const result = SessionEventSchema.safeParse(withData);
      expect(result.success).toBe(true);
    });
  });

  describe('SessionMetadataInputSchema', () => {
    // Auto-assigned fields can be omitted
    it('allows omitting status and started_at', () => {
      const input = {
        id: '01ABC123',
        agent_type: 'claude',
      };
      const result = SessionMetadataInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('allows overriding status', () => {
      const input = {
        id: '01ABC123',
        agent_type: 'claude',
        status: 'completed' as const,
      };
      const result = SessionMetadataInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('completed');
      }
    });

    it('allows overriding started_at', () => {
      const input = {
        id: '01ABC123',
        agent_type: 'claude',
        started_at: '2026-01-29T10:00:00.000Z',
      };
      const result = SessionMetadataInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe('SessionEventInputSchema', () => {
    // Auto-assigned ts and seq can be omitted
    it('allows omitting ts and seq', () => {
      const input = {
        type: 'session.start' as const,
        session_id: '01ABC123',
        data: {},
      };
      const result = SessionEventInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('allows overriding ts and seq', () => {
      const input = {
        ts: 1706522400000,
        seq: 5,
        type: 'note' as const,
        session_id: '01ABC123',
        data: { content: 'test' },
      };
      const result = SessionEventInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ts).toBe(1706522400000);
        expect(result.data.seq).toBe(5);
      }
    });
  });

  describe('Event Data Schemas', () => {
    describe('SessionStartDataSchema', () => {
      it('accepts empty object', () => {
        const result = SessionStartDataSchema.safeParse({});
        expect(result.success).toBe(true);
      });

      it('accepts trigger and context', () => {
        const data = {
          trigger: 'user_message',
          context: { channel: 'discord', guild_id: '123' },
        };
        const result = SessionStartDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });

    describe('SessionEndDataSchema', () => {
      // AC: @mem-agent-sessions ac-4 - final status on end
      it('requires final_status', () => {
        const result = SessionEndDataSchema.safeParse({ reason: 'user ended' });
        expect(result.success).toBe(false);
      });

      it('accepts complete end data', () => {
        const data = {
          reason: 'completed normally',
          final_status: 'completed' as const,
        };
        const result = SessionEndDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });

      it('accepts error on abandoned', () => {
        const data = {
          reason: 'crash',
          final_status: 'abandoned' as const,
          error: 'Connection timeout',
        };
        const result = SessionEndDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });

    describe('SessionUpdateDataSchema', () => {
      // AC: @mem-agent-sessions ac-8 - persist full SessionUpdate
      it('requires update_type', () => {
        const result = SessionUpdateDataSchema.safeParse({ payload: {} });
        expect(result.success).toBe(false);
      });

      it('accepts update with any payload', () => {
        const data = {
          update_type: 'agent_message_chunk',
          payload: { content: { text: 'Hello!' } },
        };
        const result = SessionUpdateDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });

      it('accepts tool_use update type', () => {
        const data = {
          update_type: 'tool_use',
          payload: { tool_name: 'calculator', arguments: { a: 1, b: 2 } },
        };
        const result = SessionUpdateDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });

    describe('PromptSentDataSchema', () => {
      it('requires content', () => {
        const result = PromptSentDataSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('accepts prompt with optional fields', () => {
        const data = {
          content: 'Hello, how are you?',
          model: 'claude-3-opus',
          tokens: 50,
        };
        const result = PromptSentDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });

    describe('MessageChunkDataSchema', () => {
      // AC: @mem-agent-sessions ac-2 - streaming chunks
      it('requires content', () => {
        const result = MessageChunkDataSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('accepts chunk with metadata', () => {
        const data = {
          content: 'Hello',
          is_final: false,
          chunk_index: 0,
        };
        const result = MessageChunkDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });

      it('accepts final chunk', () => {
        const data = {
          content: '!',
          is_final: true,
          chunk_index: 5,
        };
        const result = MessageChunkDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });

    describe('ToolCallDataSchema', () => {
      // AC: @mem-agent-sessions ac-3 - tool call with correlation
      it('requires tool_name', () => {
        const result = ToolCallDataSchema.safeParse({ arguments: {} });
        expect(result.success).toBe(false);
      });

      it('accepts tool call with call_id for correlation', () => {
        const data = {
          tool_name: 'read_file',
          arguments: { path: '/tmp/test.txt' },
          call_id: 'call-123',
        };
        const result = ToolCallDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });

      it('rejects empty tool_name', () => {
        const data = {
          tool_name: '',
          arguments: {},
        };
        const result = ToolCallDataSchema.safeParse(data);
        expect(result.success).toBe(false);
      });
    });

    describe('ToolResultDataSchema', () => {
      // AC: @mem-agent-sessions ac-3 - tool result with correlation
      it('requires tool_name and success', () => {
        const result = ToolResultDataSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('accepts successful result', () => {
        const data = {
          tool_name: 'read_file',
          call_id: 'call-123',
          success: true,
          result: 'file contents here',
        };
        const result = ToolResultDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });

      it('accepts failed result with error', () => {
        const data = {
          tool_name: 'read_file',
          call_id: 'call-123',
          success: false,
          error: 'File not found',
        };
        const result = ToolResultDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });

    describe('NoteDataSchema', () => {
      it('requires content', () => {
        const result = NoteDataSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('accepts note with level', () => {
        const data = {
          content: 'Debug information',
          level: 'debug' as const,
        };
        const result = NoteDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });

      it('accepts all severity levels', () => {
        const levels = ['debug', 'info', 'warn', 'error'] as const;
        for (const level of levels) {
          const result = NoteDataSchema.safeParse({ content: 'test', level });
          expect(result.success).toBe(true);
        }
      });

      it('rejects invalid level', () => {
        const data = {
          content: 'test',
          level: 'invalid',
        };
        const result = NoteDataSchema.safeParse(data);
        expect(result.success).toBe(false);
      });
    });
  });

  describe('Typed Event Schemas', () => {
    const baseEvent = {
      ts: Date.now(),
      seq: 0,
      session_id: '01ABC123',
    };

    describe('SessionStartEventSchema', () => {
      it('validates session start event', () => {
        const event = {
          ...baseEvent,
          type: 'session.start' as const,
          data: { trigger: 'user_message' },
        };
        const result = SessionStartEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });

      it('rejects wrong type', () => {
        const event = {
          ...baseEvent,
          type: 'session.end' as const,
          data: { trigger: 'user_message' },
        };
        const result = SessionStartEventSchema.safeParse(event);
        expect(result.success).toBe(false);
      });
    });

    describe('SessionEndEventSchema', () => {
      // AC: @mem-agent-sessions ac-4 - final status on end
      it('validates session end event', () => {
        const event = {
          ...baseEvent,
          type: 'session.end' as const,
          data: { final_status: 'completed' as const },
        };
        const result = SessionEndEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe('SessionUpdateEventSchema', () => {
      // AC: @mem-agent-sessions ac-8 - persist full SessionUpdate
      it('validates session update event', () => {
        const event = {
          ...baseEvent,
          type: 'session.update' as const,
          data: { update_type: 'agent_message_chunk', payload: { content: { text: 'Hi' } } },
        };
        const result = SessionUpdateEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });

      it('rejects wrong type', () => {
        const event = {
          ...baseEvent,
          type: 'prompt.sent' as const,
          data: { update_type: 'agent_message_chunk', payload: {} },
        };
        const result = SessionUpdateEventSchema.safeParse(event);
        expect(result.success).toBe(false);
      });
    });

    describe('PromptSentEventSchema', () => {
      it('validates prompt sent event', () => {
        const event = {
          ...baseEvent,
          type: 'prompt.sent' as const,
          data: { content: 'Hello!' },
        };
        const result = PromptSentEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe('MessageChunkEventSchema', () => {
      // AC: @mem-agent-sessions ac-2 - chunk events
      it('validates message chunk event', () => {
        const event = {
          ...baseEvent,
          seq: 5,
          type: 'message.chunk' as const,
          data: { content: 'Hello', is_final: false },
        };
        const result = MessageChunkEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe('ToolCallEventSchema', () => {
      // AC: @mem-agent-sessions ac-3 - tool call events
      it('validates tool call event with trace_id', () => {
        const event = {
          ...baseEvent,
          type: 'tool.call' as const,
          trace_id: 'trace-123',
          data: { tool_name: 'read_file', arguments: { path: '/tmp/test' } },
        };
        const result = ToolCallEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe('ToolResultEventSchema', () => {
      // AC: @mem-agent-sessions ac-3 - tool result events
      it('validates tool result event with correlation', () => {
        const event = {
          ...baseEvent,
          seq: 1,
          type: 'tool.result' as const,
          trace_id: 'trace-123',
          data: { tool_name: 'read_file', success: true, result: 'contents' },
        };
        const result = ToolResultEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe('NoteEventSchema', () => {
      it('validates note event', () => {
        const event = {
          ...baseEvent,
          type: 'note' as const,
          data: { content: 'Debug info', level: 'debug' as const },
        };
        const result = NoteEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('TypedSessionEventSchema', () => {
    const baseEvent = {
      ts: Date.now(),
      seq: 0,
      session_id: '01ABC123',
    };

    it('validates any typed event', () => {
      const events = [
        { ...baseEvent, type: 'session.start' as const, data: {} },
        {
          ...baseEvent,
          type: 'session.end' as const,
          data: { final_status: 'completed' as const },
        },
        {
          ...baseEvent,
          type: 'session.update' as const,
          data: { update_type: 'agent_message_chunk', payload: {} },
        },
        { ...baseEvent, type: 'prompt.sent' as const, data: { content: 'hi' } },
        { ...baseEvent, type: 'message.chunk' as const, data: { content: 'chunk' } },
        { ...baseEvent, type: 'tool.call' as const, data: { tool_name: 'test', arguments: {} } },
        { ...baseEvent, type: 'tool.result' as const, data: { tool_name: 'test', success: true } },
        { ...baseEvent, type: 'note' as const, data: { content: 'note' } },
      ];

      for (const event of events) {
        const result = TypedSessionEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      }
    });

    // AC: @mem-agent-sessions ac-6 - rejects invalid event data
    it('rejects events with mismatched type and data', () => {
      // session.end requires final_status in data
      const event = {
        ...baseEvent,
        type: 'session.end' as const,
        data: { content: 'wrong data shape' },
      };
      const result = TypedSessionEventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });
  });
});
