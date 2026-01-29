/**
 * Conversation Zod Schemas
 *
 * Defines schemas for conversation metadata and turns.
 * Two-layer conversation tracking: user threads linked to agent sessions.
 *
 * @see @mem-conversation
 */

import { z } from 'zod';

// ============================================================================
// Conversation Status
// ============================================================================

/**
 * Valid conversation status values
 * - active: Conversation is ongoing
 * - archived: Conversation is no longer active
 */
export const ConversationStatusSchema = z.enum(['active', 'archived']);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

// ============================================================================
// Turn Role
// ============================================================================

/**
 * Valid turn role values
 * - user: Message from the user
 * - assistant: Response from the LLM/bot
 * - system: System-generated message
 */
export const TurnRoleSchema = z.enum(['user', 'assistant', 'system']);
export type TurnRole = z.infer<typeof TurnRoleSchema>;

// ============================================================================
// Conversation Metadata
// ============================================================================

/**
 * Conversation metadata schema (conversation.yaml)
 *
 * Tracks conversation-level information, separate from individual turns.
 */
export const ConversationMetadataSchema = z.object({
  /** Unique conversation identifier (ULID) */
  id: z.string().min(1),
  /** Session key for routing (agent:X:platform:kind:peer format) */
  session_key: z.string().min(1),
  /** Current conversation status */
  status: ConversationStatusSchema,
  /** ISO 8601 timestamp when conversation was created */
  created_at: z.string().datetime(),
  /** ISO 8601 timestamp when conversation was last updated */
  updated_at: z.string().datetime(),
  /** Total number of turns in the conversation */
  turn_count: z.number().int().nonnegative(),
  /** Optional platform-specific or custom metadata */
  metadata: z.record(z.unknown()).optional(),
});
export type ConversationMetadata = z.infer<typeof ConversationMetadataSchema>;

// ============================================================================
// Conversation Turn
// ============================================================================

/**
 * Conversation turn schema (turns.jsonl entries)
 *
 * AC: @mem-conversation ac-1 - Turn fields: role, content, ts, seq
 * AC: @mem-conversation ac-2 - agent_session_id links to agent sessions
 * AC: @mem-conversation ac-4 - message_id for idempotency/dedup
 * AC: @mem-conversation ac-6 - Zod validation for turns
 */
export const ConversationTurnSchema = z.object({
  /** Unix timestamp in milliseconds (auto-assigned if not provided) */
  ts: z.number().int().positive(),
  /** Turn sequence number, monotonically increasing per conversation (auto-assigned) */
  seq: z.number().int().nonnegative(),
  /** Role of the message author */
  role: TurnRoleSchema,
  /** Content of the turn/message */
  content: z.string(),
  /** Links to AgentSession that generated this turn (for assistant turns) */
  agent_session_id: z.string().optional(),
  /** Platform message ID for idempotency/deduplication */
  message_id: z.string().optional(),
  /** Optional platform-specific or custom metadata */
  metadata: z.record(z.unknown()).optional(),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

// ============================================================================
// Input Schemas (for creating new records)
// ============================================================================

/**
 * Input schema for creating conversation metadata.
 * Omits auto-assigned fields (timestamps and turn_count default)
 */
export const ConversationMetadataInputSchema = ConversationMetadataSchema.omit({
  status: true,
  created_at: true,
  updated_at: true,
  turn_count: true,
}).extend({
  /** Optional status override (defaults to 'active') */
  status: ConversationStatusSchema.optional(),
  /** Optional created_at override (defaults to current time) */
  created_at: z.string().datetime().optional(),
  /** Optional updated_at override (defaults to current time) */
  updated_at: z.string().datetime().optional(),
  /** Optional turn_count override (defaults to 0) */
  turn_count: z.number().int().nonnegative().optional(),
});
export type ConversationMetadataInput = z.infer<typeof ConversationMetadataInputSchema>;

/**
 * Input schema for appending turns.
 * Omits auto-assigned ts and seq fields.
 */
export const ConversationTurnInputSchema = ConversationTurnSchema.omit({
  ts: true,
  seq: true,
}).extend({
  /** Optional timestamp override (defaults to current time) */
  ts: z.number().int().positive().optional(),
  /** Optional sequence override (defaults to next in sequence) */
  seq: z.number().int().nonnegative().optional(),
});
export type ConversationTurnInput = z.infer<typeof ConversationTurnInputSchema>;

// ============================================================================
// Conversation Events
// ============================================================================

/**
 * Event types emitted by conversation operations
 *
 * AC: @mem-conversation ac-5 - Structured events for turn operations
 */
export const ConversationEventTypeSchema = z.enum([
  'conversation_created',
  'conversation_updated',
  'conversation_archived',
  'turn_appended',
  'turn_recovered',
]);
export type ConversationEventType = z.infer<typeof ConversationEventTypeSchema>;

/**
 * Base conversation event schema
 */
export const ConversationEventSchema = z.object({
  /** Event type */
  type: ConversationEventTypeSchema,
  /** Conversation ID this event relates to */
  conversation_id: z.string().min(1),
  /** Unix timestamp in milliseconds */
  ts: z.number().int().positive(),
  /** Event-specific payload */
  data: z.unknown(),
});
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;

// ============================================================================
// Typed Event Data Schemas
// ============================================================================

/**
 * Data payload for conversation_created events
 */
export const ConversationCreatedDataSchema = z.object({
  /** Session key for the new conversation */
  session_key: z.string().min(1),
  /** Optional trigger information */
  trigger: z.string().optional(),
});
export type ConversationCreatedData = z.infer<typeof ConversationCreatedDataSchema>;

/**
 * Data payload for conversation_updated events
 */
export const ConversationUpdatedDataSchema = z.object({
  /** Fields that were updated */
  updated_fields: z.array(z.string()),
  /** New turn count if updated */
  turn_count: z.number().int().nonnegative().optional(),
});
export type ConversationUpdatedData = z.infer<typeof ConversationUpdatedDataSchema>;

/**
 * Data payload for conversation_archived events
 */
export const ConversationArchivedDataSchema = z.object({
  /** Reason for archiving */
  reason: z.string().optional(),
  /** Final turn count */
  final_turn_count: z.number().int().nonnegative(),
});
export type ConversationArchivedData = z.infer<typeof ConversationArchivedDataSchema>;

/**
 * Data payload for turn_appended events
 *
 * AC: @mem-conversation ac-5 - turn_appended event
 */
export const TurnAppendedDataSchema = z.object({
  /** Sequence number of the appended turn */
  seq: z.number().int().nonnegative(),
  /** Role of the turn */
  role: TurnRoleSchema,
  /** Whether this was a duplicate (idempotent append) */
  was_duplicate: z.boolean().optional(),
  /** Agent session ID if assistant turn */
  agent_session_id: z.string().optional(),
});
export type TurnAppendedData = z.infer<typeof TurnAppendedDataSchema>;

/**
 * Data payload for turn_recovered events
 *
 * AC: @mem-conversation ac-3 - Recovery on restart
 */
export const TurnRecoveredDataSchema = z.object({
  /** Number of turns recovered */
  turns_recovered: z.number().int().nonnegative(),
  /** Number of invalid lines skipped */
  lines_skipped: z.number().int().nonnegative(),
  /** Warning messages if any */
  warnings: z.array(z.string()).optional(),
});
export type TurnRecoveredData = z.infer<typeof TurnRecoveredDataSchema>;

// ============================================================================
// Typed Event Schemas
// ============================================================================

/**
 * Conversation created event with typed data
 */
export const ConversationCreatedEventSchema = ConversationEventSchema.extend({
  type: z.literal('conversation_created'),
  data: ConversationCreatedDataSchema,
});
export type ConversationCreatedEvent = z.infer<typeof ConversationCreatedEventSchema>;

/**
 * Conversation updated event with typed data
 */
export const ConversationUpdatedEventSchema = ConversationEventSchema.extend({
  type: z.literal('conversation_updated'),
  data: ConversationUpdatedDataSchema,
});
export type ConversationUpdatedEvent = z.infer<typeof ConversationUpdatedEventSchema>;

/**
 * Conversation archived event with typed data
 */
export const ConversationArchivedEventSchema = ConversationEventSchema.extend({
  type: z.literal('conversation_archived'),
  data: ConversationArchivedDataSchema,
});
export type ConversationArchivedEvent = z.infer<typeof ConversationArchivedEventSchema>;

/**
 * Turn appended event with typed data
 */
export const TurnAppendedEventSchema = ConversationEventSchema.extend({
  type: z.literal('turn_appended'),
  data: TurnAppendedDataSchema,
});
export type TurnAppendedEvent = z.infer<typeof TurnAppendedEventSchema>;

/**
 * Turn recovered event with typed data
 */
export const TurnRecoveredEventSchema = ConversationEventSchema.extend({
  type: z.literal('turn_recovered'),
  data: TurnRecoveredDataSchema,
});
export type TurnRecoveredEvent = z.infer<typeof TurnRecoveredEventSchema>;

/**
 * Union of all typed conversation event schemas
 */
export const TypedConversationEventSchema = z.union([
  ConversationCreatedEventSchema,
  ConversationUpdatedEventSchema,
  ConversationArchivedEventSchema,
  TurnAppendedEventSchema,
  TurnRecoveredEventSchema,
]);
export type TypedConversationEvent = z.infer<typeof TypedConversationEventSchema>;
