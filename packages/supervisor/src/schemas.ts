/**
 * Zod schemas for checkpoint files and IPC messages
 *
 * @see @restart-checkpoint
 */

import { z } from 'zod';

/**
 * Restart reason enumeration
 *
 * AC: @restart-checkpoint ac-3
 */
export const RestartReasonSchema = z.enum(['planned', 'upgrade', 'crash']);
export type RestartReason = z.infer<typeof RestartReasonSchema>;

/**
 * Wake context for restart
 *
 * Contains the prompt and optional context to inject when waking up.
 */
export const WakeContextSchema = z.object({
  prompt: z.string().min(1, 'Wake prompt cannot be empty'),
  pending_work: z.string().optional(),
  instructions: z.string().optional(),
});
export type WakeContext = z.infer<typeof WakeContextSchema>;

/**
 * Checkpoint file format
 *
 * AC: @restart-checkpoint ac-2, ac-7
 */
export const CheckpointSchema = z.object({
  version: z.literal(1).default(1),
  session_id: z.string().ulid(),
  restart_reason: RestartReasonSchema,
  wake_context: WakeContextSchema,
  created_at: z.string().datetime(),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

/**
 * IPC message types
 */

/**
 * Planned restart message from kbot to supervisor
 *
 * Signals that kbot wants to restart with the specified checkpoint.
 */
export const PlannedRestartMessageSchema = z.object({
  type: z.literal('planned_restart'),
  checkpoint: z.string().min(1, 'Checkpoint path cannot be empty'),
});
export type PlannedRestartMessage = z.infer<typeof PlannedRestartMessageSchema>;

/**
 * Restart acknowledgment from supervisor to kbot
 *
 * Confirms that the supervisor will restart kbot with the checkpoint.
 */
export const RestartAckMessageSchema = z.object({
  type: z.literal('restart_ack'),
});
export type RestartAckMessage = z.infer<typeof RestartAckMessageSchema>;

/**
 * Error message for IPC communication failures
 */
export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string().min(1, 'Error message cannot be empty'),
});
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

/**
 * Union of all IPC message types
 */
export const IpcMessageSchema = z.discriminatedUnion('type', [
  PlannedRestartMessageSchema,
  RestartAckMessageSchema,
  ErrorMessageSchema,
]);
export type IpcMessage = z.infer<typeof IpcMessageSchema>;
