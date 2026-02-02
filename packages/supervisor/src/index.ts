/**
 * Supervisor Package
 *
 * Manages the kbot process lifecycle, handles restart requests,
 * and preserves context via checkpoint files.
 *
 * @see @supervisor
 */

export { createLogger } from '@kynetic-bot/core';

// Supervisor
export { Supervisor } from './supervisor.js';
export type { SupervisorConfig, SupervisorEvents } from './supervisor.js';

// Checkpoint functions
export {
  writeCheckpoint,
  readCheckpoint,
  deleteCheckpoint,
  cleanupStaleCheckpoints,
} from './checkpoint.js';
export type { CheckpointWriteResult, CheckpointReadResult, CleanupResult } from './checkpoint.js';

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
