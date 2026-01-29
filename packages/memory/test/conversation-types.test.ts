/**
 * Conversation Types Tests
 *
 * Tests for conversation metadata and turn Zod schemas.
 *
 * @see @mem-conversation
 */

import { describe, expect, it } from 'vitest';
import {
  ConversationArchivedDataSchema,
  ConversationArchivedEventSchema,
  ConversationCreatedDataSchema,
  ConversationCreatedEventSchema,
  ConversationEventSchema,
  ConversationEventTypeSchema,
  ConversationMetadataInputSchema,
  ConversationMetadataSchema,
  ConversationStatusSchema,
  ConversationTurnInputSchema,
  ConversationTurnSchema,
  ConversationUpdatedDataSchema,
  ConversationUpdatedEventSchema,
  TurnAppendedDataSchema,
  TurnAppendedEventSchema,
  TurnRecoveredDataSchema,
  TurnRecoveredEventSchema,
  TurnRoleSchema,
  TypedConversationEventSchema,
} from '../src/types/conversation.js';

describe('Conversation Types', () => {
  describe('ConversationStatusSchema', () => {
    it('accepts valid status values', () => {
      expect(ConversationStatusSchema.parse('active')).toBe('active');
      expect(ConversationStatusSchema.parse('archived')).toBe('archived');
    });

    // AC: @trait-validated ac-1 - invalid input returns structured error
    it('rejects invalid status values', () => {
      const result = ConversationStatusSchema.safeParse('deleted');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toBeDefined();
      }
    });
  });

  describe('TurnRoleSchema', () => {
    // AC: @mem-conversation ac-1 - turn fields include role
    it('accepts valid role values', () => {
      expect(TurnRoleSchema.parse('user')).toBe('user');
      expect(TurnRoleSchema.parse('assistant')).toBe('assistant');
      expect(TurnRoleSchema.parse('system')).toBe('system');
    });

    it('rejects invalid role values', () => {
      const result = TurnRoleSchema.safeParse('admin');
      expect(result.success).toBe(false);
    });
  });

  describe('ConversationMetadataSchema', () => {
    const validMetadata = {
      id: '01ABC123XYZ',
      session_key: 'discord:guild:channel:user',
      status: 'active' as const,
      created_at: '2026-01-29T10:00:00.000Z',
      updated_at: '2026-01-29T10:00:00.000Z',
      turn_count: 0,
    };

    it('validates required fields', () => {
      const result = ConversationMetadataSchema.safeParse(validMetadata);
      expect(result.success).toBe(true);
    });

    it('accepts optional metadata field', () => {
      const withMetadata = {
        ...validMetadata,
        metadata: { platform: 'discord', guild_name: 'Test Server' },
      };
      const result = ConversationMetadataSchema.safeParse(withMetadata);
      expect(result.success).toBe(true);
    });

    // AC: @trait-validated ac-2 - identifies missing required field
    it('rejects missing required fields', () => {
      const missingKey = { ...validMetadata, session_key: undefined };
      const result = ConversationMetadataSchema.safeParse(missingKey);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('session_key'))).toBe(true);
      }
    });

    it('rejects negative turn_count', () => {
      const negativeTurns = { ...validMetadata, turn_count: -1 };
      const result = ConversationMetadataSchema.safeParse(negativeTurns);
      expect(result.success).toBe(false);
    });

    it('rejects empty strings for required fields', () => {
      const emptyId = { ...validMetadata, id: '' };
      const result = ConversationMetadataSchema.safeParse(emptyId);
      expect(result.success).toBe(false);
    });

    // AC: @trait-validated ac-3 - includes expected type in error
    it('rejects invalid datetime format', () => {
      const invalidDate = { ...validMetadata, created_at: 'not-a-date' };
      const result = ConversationMetadataSchema.safeParse(invalidDate);
      expect(result.success).toBe(false);
    });
  });

  describe('ConversationTurnSchema', () => {
    const validTurn = {
      ts: Date.now(),
      seq: 0,
      role: 'user' as const,
      content: 'Hello, how are you?',
    };

    // AC: @mem-conversation ac-1 - turn fields: role, content, ts, seq
    it('validates turn structure with required fields', () => {
      const result = ConversationTurnSchema.safeParse(validTurn);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe('user');
        expect(result.data.content).toBe('Hello, how are you?');
        expect(result.data.ts).toBe(validTurn.ts);
        expect(result.data.seq).toBe(0);
      }
    });

    // AC: @mem-conversation ac-2 - agent_session_id links to agent sessions
    it('accepts optional agent_session_id for assistant turns', () => {
      const assistantTurn = {
        ...validTurn,
        role: 'assistant' as const,
        agent_session_id: '01SESSION123',
      };
      const result = ConversationTurnSchema.safeParse(assistantTurn);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agent_session_id).toBe('01SESSION123');
      }
    });

    // AC: @mem-conversation ac-4 - message_id for idempotency
    it('accepts optional message_id for deduplication', () => {
      const withMessageId = {
        ...validTurn,
        message_id: 'discord-msg-123456',
      };
      const result = ConversationTurnSchema.safeParse(withMessageId);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.message_id).toBe('discord-msg-123456');
      }
    });

    it('accepts optional metadata', () => {
      const withMetadata = {
        ...validTurn,
        metadata: { attachments: 2, reactions: ['👍'] },
      };
      const result = ConversationTurnSchema.safeParse(withMetadata);
      expect(result.success).toBe(true);
    });

    // AC: @mem-conversation ac-6 - rejects invalid turn data
    it('rejects negative sequence numbers', () => {
      const negativeSeq = { ...validTurn, seq: -1 };
      const result = ConversationTurnSchema.safeParse(negativeSeq);
      expect(result.success).toBe(false);
    });

    it('rejects zero or negative timestamps', () => {
      const zeroTs = { ...validTurn, ts: 0 };
      const result = ConversationTurnSchema.safeParse(zeroTs);
      expect(result.success).toBe(false);

      const negativeTs = { ...validTurn, ts: -1000 };
      const result2 = ConversationTurnSchema.safeParse(negativeTs);
      expect(result2.success).toBe(false);
    });

    it('rejects missing content', () => {
      const noContent = { ts: Date.now(), seq: 0, role: 'user' };
      const result = ConversationTurnSchema.safeParse(noContent);
      expect(result.success).toBe(false);
    });
  });

  describe('ConversationMetadataInputSchema', () => {
    it('allows omitting auto-assigned fields', () => {
      const input = {
        id: '01ABC123',
        session_key: 'discord:guild:channel:user',
      };
      const result = ConversationMetadataInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('allows overriding status', () => {
      const input = {
        id: '01ABC123',
        session_key: 'discord:guild:channel:user',
        status: 'archived' as const,
      };
      const result = ConversationMetadataInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('archived');
      }
    });

    it('allows overriding timestamps and turn_count', () => {
      const input = {
        id: '01ABC123',
        session_key: 'discord:guild:channel:user',
        created_at: '2026-01-29T10:00:00.000Z',
        updated_at: '2026-01-29T11:00:00.000Z',
        turn_count: 5,
      };
      const result = ConversationMetadataInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe('ConversationTurnInputSchema', () => {
    it('allows omitting ts and seq', () => {
      const input = {
        role: 'user' as const,
        content: 'Hello!',
      };
      const result = ConversationTurnInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('allows overriding ts and seq', () => {
      const input = {
        ts: 1706522400000,
        seq: 5,
        role: 'assistant' as const,
        content: 'Hi there!',
        agent_session_id: '01SESSION',
      };
      const result = ConversationTurnInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ts).toBe(1706522400000);
        expect(result.data.seq).toBe(5);
      }
    });
  });

  describe('ConversationEventTypeSchema', () => {
    // AC: @mem-conversation ac-5 - event types for turn operations
    it('accepts all event types', () => {
      const validTypes = [
        'conversation_created',
        'conversation_updated',
        'conversation_archived',
        'turn_appended',
        'turn_recovered',
      ];

      for (const type of validTypes) {
        expect(ConversationEventTypeSchema.parse(type)).toBe(type);
      }
    });

    it('rejects invalid event types', () => {
      const result = ConversationEventTypeSchema.safeParse('invalid_event');
      expect(result.success).toBe(false);
    });
  });

  describe('ConversationEventSchema', () => {
    const validEvent = {
      type: 'conversation_created' as const,
      conversation_id: '01CONV123',
      ts: Date.now(),
      data: {},
    };

    it('validates base event structure', () => {
      const result = ConversationEventSchema.safeParse(validEvent);
      expect(result.success).toBe(true);
    });

    it('rejects missing conversation_id', () => {
      const noConvId = { ...validEvent, conversation_id: undefined };
      const result = ConversationEventSchema.safeParse(noConvId);
      expect(result.success).toBe(false);
    });

    it('rejects empty conversation_id', () => {
      const emptyConvId = { ...validEvent, conversation_id: '' };
      const result = ConversationEventSchema.safeParse(emptyConvId);
      expect(result.success).toBe(false);
    });
  });

  describe('Event Data Schemas', () => {
    describe('ConversationCreatedDataSchema', () => {
      it('requires session_key', () => {
        const result = ConversationCreatedDataSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('accepts session_key with optional trigger', () => {
        const data = {
          session_key: 'discord:guild:channel:user',
          trigger: 'user_dm',
        };
        const result = ConversationCreatedDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });

    describe('ConversationUpdatedDataSchema', () => {
      it('requires updated_fields array', () => {
        const result = ConversationUpdatedDataSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('accepts update data', () => {
        const data = {
          updated_fields: ['updated_at', 'turn_count'],
          turn_count: 10,
        };
        const result = ConversationUpdatedDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });

    describe('ConversationArchivedDataSchema', () => {
      it('requires final_turn_count', () => {
        const result = ConversationArchivedDataSchema.safeParse({ reason: 'inactive' });
        expect(result.success).toBe(false);
      });

      it('accepts archive data', () => {
        const data = {
          reason: 'user requested',
          final_turn_count: 25,
        };
        const result = ConversationArchivedDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });

    describe('TurnAppendedDataSchema', () => {
      // AC: @mem-conversation ac-5 - turn_appended event data
      it('requires seq and role', () => {
        const result = TurnAppendedDataSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('accepts turn appended data', () => {
        const data = {
          seq: 5,
          role: 'assistant' as const,
          agent_session_id: '01SESSION',
        };
        const result = TurnAppendedDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });

      // AC: @trait-idempotent ac-1 - duplicate detection
      it('accepts was_duplicate flag for idempotent operations', () => {
        const data = {
          seq: 3,
          role: 'user' as const,
          was_duplicate: true,
        };
        const result = TurnAppendedDataSchema.safeParse(data);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.was_duplicate).toBe(true);
        }
      });
    });

    describe('TurnRecoveredDataSchema', () => {
      // AC: @mem-conversation ac-3 - recovery event data
      it('requires recovery counts', () => {
        const result = TurnRecoveredDataSchema.safeParse({});
        expect(result.success).toBe(false);
      });

      it('accepts recovery data with warnings', () => {
        const data = {
          turns_recovered: 10,
          lines_skipped: 2,
          warnings: ['Line 5: invalid JSON', 'Line 8: missing role field'],
        };
        const result = TurnRecoveredDataSchema.safeParse(data);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.warnings).toHaveLength(2);
        }
      });

      it('accepts recovery data without warnings', () => {
        const data = {
          turns_recovered: 15,
          lines_skipped: 0,
        };
        const result = TurnRecoveredDataSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Typed Event Schemas', () => {
    const baseEvent = {
      conversation_id: '01CONV123',
      ts: Date.now(),
    };

    describe('ConversationCreatedEventSchema', () => {
      // AC: @mem-conversation ac-5 - conversation_created event
      it('validates conversation created event', () => {
        const event = {
          ...baseEvent,
          type: 'conversation_created' as const,
          data: { session_key: 'discord:guild:channel:user' },
        };
        const result = ConversationCreatedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });

      it('rejects wrong type', () => {
        const event = {
          ...baseEvent,
          type: 'turn_appended' as const,
          data: { session_key: 'discord:guild:channel:user' },
        };
        const result = ConversationCreatedEventSchema.safeParse(event);
        expect(result.success).toBe(false);
      });
    });

    describe('ConversationUpdatedEventSchema', () => {
      it('validates conversation updated event', () => {
        const event = {
          ...baseEvent,
          type: 'conversation_updated' as const,
          data: { updated_fields: ['turn_count'] },
        };
        const result = ConversationUpdatedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe('ConversationArchivedEventSchema', () => {
      it('validates conversation archived event', () => {
        const event = {
          ...baseEvent,
          type: 'conversation_archived' as const,
          data: { final_turn_count: 50 },
        };
        const result = ConversationArchivedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe('TurnAppendedEventSchema', () => {
      // AC: @mem-conversation ac-5 - turn_appended event
      it('validates turn appended event', () => {
        const event = {
          ...baseEvent,
          type: 'turn_appended' as const,
          data: { seq: 0, role: 'user' as const },
        };
        const result = TurnAppendedEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });

    describe('TurnRecoveredEventSchema', () => {
      // AC: @mem-conversation ac-3 - turn_recovered event
      it('validates turn recovered event', () => {
        const event = {
          ...baseEvent,
          type: 'turn_recovered' as const,
          data: { turns_recovered: 10, lines_skipped: 1 },
        };
        const result = TurnRecoveredEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('TypedConversationEventSchema', () => {
    const baseEvent = {
      conversation_id: '01CONV123',
      ts: Date.now(),
    };

    it('validates any typed event', () => {
      const events = [
        { ...baseEvent, type: 'conversation_created' as const, data: { session_key: 'key' } },
        { ...baseEvent, type: 'conversation_updated' as const, data: { updated_fields: ['x'] } },
        { ...baseEvent, type: 'conversation_archived' as const, data: { final_turn_count: 10 } },
        { ...baseEvent, type: 'turn_appended' as const, data: { seq: 0, role: 'user' as const } },
        { ...baseEvent, type: 'turn_recovered' as const, data: { turns_recovered: 5, lines_skipped: 0 } },
      ];

      for (const event of events) {
        const result = TypedConversationEventSchema.safeParse(event);
        expect(result.success).toBe(true);
      }
    });

    // AC: @mem-conversation ac-6 - rejects invalid data
    it('rejects events with mismatched type and data', () => {
      // turn_appended requires seq and role in data
      const event = {
        ...baseEvent,
        type: 'turn_appended' as const,
        data: { session_key: 'wrong data shape' },
      };
      const result = TypedConversationEventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });
  });
});
