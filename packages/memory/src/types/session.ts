/**
 * Agent Session Zod Schemas
 *
 * Defines schemas for agent session metadata and events.
 * Used for tracking LLM interactions as JSONL events for audit trails.
 *
 * @see @mem-agent-sessions
 */

import { z } from 'zod';

// ============================================================================
// Session Status
// ============================================================================

/**
 * Valid session status values
 * - active: Session is currently in progress
 * - completed: Session ended normally
 * - abandoned: Session ended abnormally (crash, timeout)
 */
export const AgentSessionStatusSchema = z.enum(['active', 'completed', 'abandoned']);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;

// ============================================================================
// Event Types
// ============================================================================

/**
 * Valid session event types
 * - session.start: Session began
 * - session.end: Session completed/abandoned
 * - prompt.sent: LLM prompt was sent
 * - message.chunk: Streaming response chunk received
 * - tool.call: Tool invocation requested
 * - tool.result: Tool execution completed
 * - note: Informational/debug event
 */
export const SessionEventTypeSchema = z.enum([
  'session.start',
  'session.end',
  'prompt.sent',
  'message.chunk',
  'tool.call',
  'tool.result',
  'note',
]);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

// ============================================================================
// Session Metadata
// ============================================================================

/**
 * Agent session metadata schema (session.yaml)
 *
 * AC: @mem-agent-sessions ac-1 - Session file with required fields
 */
export const AgentSessionMetadataSchema = z.object({
  /** Unique session identifier (ULID) */
  id: z.string().min(1),
  /** Links session to conversation for context */
  conversation_id: z.string().optional(),
  /** Type of agent (e.g., 'claude', 'openai') */
  agent_type: z.string().min(1),
  /** Session key from @kynetic-bot/core for routing */
  session_key: z.string().optional(),
  /** Current session status */
  status: AgentSessionStatusSchema,
  /** ISO 8601 timestamp when session started */
  started_at: z.string().datetime(),
  /** ISO 8601 timestamp when session ended (only set for completed/abandoned) */
  ended_at: z.string().datetime().optional(),
});
export type AgentSessionMetadata = z.infer<typeof AgentSessionMetadataSchema>;

// ============================================================================
// Session Events
// ============================================================================

/**
 * Base session event schema (events.jsonl entries)
 *
 * AC: @mem-agent-sessions ac-2 - Events have auto-assigned ts and seq
 * AC: @mem-agent-sessions ac-3 - Tool events have correlation via trace_id
 * AC: @mem-agent-sessions ac-6 - Zod validation for events
 */
export const SessionEventSchema = z.object({
  /** Unix timestamp in milliseconds (auto-assigned if not provided) */
  ts: z.number().int().positive(),
  /** Sequence number, monotonically increasing per session (auto-assigned) */
  seq: z.number().int().nonnegative(),
  /** Event type */
  type: SessionEventTypeSchema,
  /** Session this event belongs to */
  session_id: z.string().min(1),
  /** Trace ID for correlating related events (e.g., tool.call with tool.result) */
  trace_id: z.string().optional(),
  /** Event-specific payload */
  data: z.unknown(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

// ============================================================================
// Input Schemas (for creating new records)
// ============================================================================

/**
 * Input schema for creating session metadata.
 * Omits auto-assigned fields (status defaults to 'active', started_at auto-set)
 */
export const SessionMetadataInputSchema = AgentSessionMetadataSchema.omit({
  status: true,
  started_at: true,
  ended_at: true,
}).extend({
  /** Optional status override (defaults to 'active') */
  status: AgentSessionStatusSchema.optional(),
  /** Optional started_at override (defaults to current time) */
  started_at: z.string().datetime().optional(),
});
export type SessionMetadataInput = z.infer<typeof SessionMetadataInputSchema>;

/**
 * Input schema for appending events.
 * Omits auto-assigned ts and seq fields.
 */
export const SessionEventInputSchema = SessionEventSchema.omit({
  ts: true,
  seq: true,
}).extend({
  /** Optional timestamp override (defaults to current time) */
  ts: z.number().int().positive().optional(),
  /** Optional sequence override (defaults to next in sequence) */
  seq: z.number().int().nonnegative().optional(),
});
export type SessionEventInput = z.infer<typeof SessionEventInputSchema>;

// ============================================================================
// Event Data Schemas (typed payloads for specific event types)
// ============================================================================

/**
 * Data payload for session.start events
 */
export const SessionStartDataSchema = z.object({
  /** Trigger that started the session */
  trigger: z.string().optional(),
  /** Initial context or configuration */
  context: z.record(z.unknown()).optional(),
});
export type SessionStartData = z.infer<typeof SessionStartDataSchema>;

/**
 * Data payload for session.end events
 *
 * AC: @mem-agent-sessions ac-4 - Final status on end
 */
export const SessionEndDataSchema = z.object({
  /** Why the session ended */
  reason: z.string().optional(),
  /** Final status */
  final_status: AgentSessionStatusSchema,
  /** Error details if abandoned due to error */
  error: z.string().optional(),
});
export type SessionEndData = z.infer<typeof SessionEndDataSchema>;

/**
 * Data payload for prompt.sent events
 */
export const PromptSentDataSchema = z.object({
  /** The prompt content sent to LLM */
  content: z.string(),
  /** Model being used */
  model: z.string().optional(),
  /** Token count if available */
  tokens: z.number().int().nonnegative().optional(),
});
export type PromptSentData = z.infer<typeof PromptSentDataSchema>;

/**
 * Data payload for message.chunk events
 *
 * AC: @mem-agent-sessions ac-2 - Streaming chunks
 */
export const MessageChunkDataSchema = z.object({
  /** Chunk content */
  content: z.string(),
  /** Whether this is the final chunk */
  is_final: z.boolean().optional(),
  /** Chunk index within the stream */
  chunk_index: z.number().int().nonnegative().optional(),
});
export type MessageChunkData = z.infer<typeof MessageChunkDataSchema>;

/**
 * Data payload for tool.call events
 *
 * AC: @mem-agent-sessions ac-3 - Tool call with correlation
 */
export const ToolCallDataSchema = z.object({
  /** Tool name being called */
  tool_name: z.string().min(1),
  /** Tool input arguments */
  arguments: z.unknown(),
  /** Unique call ID for correlation with result */
  call_id: z.string().optional(),
});
export type ToolCallData = z.infer<typeof ToolCallDataSchema>;

/**
 * Data payload for tool.result events
 *
 * AC: @mem-agent-sessions ac-3 - Tool result with correlation
 */
export const ToolResultDataSchema = z.object({
  /** Tool name that was called */
  tool_name: z.string().min(1),
  /** Call ID correlating to tool.call event */
  call_id: z.string().optional(),
  /** Whether the tool succeeded */
  success: z.boolean(),
  /** Result value on success */
  result: z.unknown().optional(),
  /** Error message on failure */
  error: z.string().optional(),
});
export type ToolResultData = z.infer<typeof ToolResultDataSchema>;

/**
 * Data payload for note events
 */
export const NoteDataSchema = z.object({
  /** Note content */
  content: z.string(),
  /** Optional severity level */
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
});
export type NoteData = z.infer<typeof NoteDataSchema>;

// ============================================================================
// Typed Event Schemas
// ============================================================================

/**
 * Session start event with typed data
 */
export const SessionStartEventSchema = SessionEventSchema.extend({
  type: z.literal('session.start'),
  data: SessionStartDataSchema,
});
export type SessionStartEvent = z.infer<typeof SessionStartEventSchema>;

/**
 * Session end event with typed data
 */
export const SessionEndEventSchema = SessionEventSchema.extend({
  type: z.literal('session.end'),
  data: SessionEndDataSchema,
});
export type SessionEndEvent = z.infer<typeof SessionEndEventSchema>;

/**
 * Prompt sent event with typed data
 */
export const PromptSentEventSchema = SessionEventSchema.extend({
  type: z.literal('prompt.sent'),
  data: PromptSentDataSchema,
});
export type PromptSentEvent = z.infer<typeof PromptSentEventSchema>;

/**
 * Message chunk event with typed data
 */
export const MessageChunkEventSchema = SessionEventSchema.extend({
  type: z.literal('message.chunk'),
  data: MessageChunkDataSchema,
});
export type MessageChunkEvent = z.infer<typeof MessageChunkEventSchema>;

/**
 * Tool call event with typed data
 */
export const ToolCallEventSchema = SessionEventSchema.extend({
  type: z.literal('tool.call'),
  data: ToolCallDataSchema,
});
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

/**
 * Tool result event with typed data
 */
export const ToolResultEventSchema = SessionEventSchema.extend({
  type: z.literal('tool.result'),
  data: ToolResultDataSchema,
});
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

/**
 * Note event with typed data
 */
export const NoteEventSchema = SessionEventSchema.extend({
  type: z.literal('note'),
  data: NoteDataSchema,
});
export type NoteEvent = z.infer<typeof NoteEventSchema>;

/**
 * Union of all typed event schemas
 */
export const TypedSessionEventSchema = z.union([
  SessionStartEventSchema,
  SessionEndEventSchema,
  PromptSentEventSchema,
  MessageChunkEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  NoteEventSchema,
]);
export type TypedSessionEvent = z.infer<typeof TypedSessionEventSchema>;
