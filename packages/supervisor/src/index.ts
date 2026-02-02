/**
 * Supervisor Package
 *
 * Manages the kbot process lifecycle, handles restart requests,
 * and preserves context via checkpoint files.
 *
 * @see @supervisor
 */

export { createLogger } from '@kynetic-bot/core';

// Checkpoint and IPC schemas
export {
  RestartReasonSchema,
  WakeContextSchema,
  CheckpointSchema,
  PlannedRestartMessageSchema,
  RestartAckMessageSchema,
  ErrorMessageSchema,
  IpcMessageSchema,
} from './schemas.js';

// Types
export type {
  RestartReason,
  WakeContext,
  Checkpoint,
  PlannedRestartMessage,
  RestartAckMessage,
  ErrorMessage,
  IpcMessage,
} from './schemas.js';
