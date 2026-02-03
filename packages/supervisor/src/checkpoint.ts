/**
 * Checkpoint file persistence and validation
 *
 * Manages checkpoint files for restart context. Checkpoints store session state,
 * restart reason, and wake-up context that survives restarts.
 *
 * @see @restart-checkpoint
 */

import { readFile, writeFile, unlink, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  type Checkpoint,
  CheckpointSchema,
  type RestartReason,
  type WakeContext,
} from './schemas.js';
import { createLogger, type Logger } from '@kynetic-bot/core';

const log: Logger = createLogger('checkpoint');

/**
 * Maximum age for checkpoint files in milliseconds (24 hours)
 * AC: @restart-checkpoint ac-4
 */
const MAX_CHECKPOINT_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Result of checkpoint write operation
 */
export interface CheckpointWriteResult {
  success: boolean;
  path?: string;
  error?: Error;
}

/**
 * Result of checkpoint read operation
 */
export interface CheckpointReadResult {
  success: boolean;
  checkpoint?: Checkpoint;
  error?: Error;
  warning?: string;
}

/**
 * Write checkpoint to .kbot/checkpoints/{ulid}.yaml
 *
 * AC: @restart-checkpoint ac-1, ac-8
 *
 * @param dataDir - Base data directory (e.g., '.kbot')
 * @param sessionId - Session ID (ULID)
 * @param restartReason - Reason for restart
 * @param wakeContext - Wake-up context with prompt
 * @returns Write result with path or error
 */
export async function writeCheckpoint(
  dataDir: string,
  sessionId: string,
  restartReason: RestartReason,
  wakeContext: WakeContext
): Promise<CheckpointWriteResult> {
  try {
    // AC: @restart-checkpoint ac-1
    const checkpointId = ulid();
    const checkpointsDir = join(dataDir, 'checkpoints');
    const checkpointPath = join(checkpointsDir, `${checkpointId}.yaml`);

    // Create checkpoint object
    // AC: @restart-checkpoint ac-2, ac-3
    const checkpoint: Checkpoint = {
      version: 1,
      session_id: sessionId,
      restart_reason: restartReason,
      wake_context: wakeContext,
      created_at: new Date().toISOString(),
    };

    // Validate checkpoint
    CheckpointSchema.parse(checkpoint);

    // Ensure directory exists
    await mkdir(checkpointsDir, { recursive: true });

    // Write to file
    const yamlContent = stringifyYaml(checkpoint);
    await writeFile(checkpointPath, yamlContent, 'utf-8');

    log.info('Checkpoint written', { path: checkpointPath, reason: restartReason });

    return {
      success: true,
      path: checkpointPath,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    // AC: @restart-checkpoint ac-8
    log.error('Failed to write checkpoint', {
      error: error.message,
      stack: error.stack,
    });

    return {
      success: false,
      error,
    };
  }
}

/**
 * Read and validate checkpoint from file
 *
 * AC: @restart-checkpoint ac-4, ac-5, ac-6, ac-7
 *
 * @param checkpointPath - Path to checkpoint file
 * @returns Read result with checkpoint or error/warning
 */
export async function readCheckpoint(checkpointPath: string): Promise<CheckpointReadResult> {
  try {
    // Read file
    const content = await readFile(checkpointPath, 'utf-8');
    const data = parseYaml(content) as unknown;

    // AC: @restart-checkpoint ac-6
    // Validate checkpoint structure
    const parseResult = CheckpointSchema.safeParse(data);
    if (!parseResult.success) {
      log.error('Checkpoint validation failed', {
        path: checkpointPath,
        errors: parseResult.error.issues,
      });

      return {
        success: false,
        error: new Error(`Invalid checkpoint format: ${parseResult.error.message}`),
      };
    }

    const checkpoint = parseResult.data;

    // AC: @restart-checkpoint ac-4
    // Check age (24-hour TTL)
    const createdAt = new Date(checkpoint.created_at);
    const age = Date.now() - createdAt.getTime();

    if (age > MAX_CHECKPOINT_AGE_MS) {
      const ageHours = Math.round(age / (60 * 60 * 1000));
      log.warn('Checkpoint too old, ignoring', {
        path: checkpointPath,
        ageHours,
        maxHours: 24,
      });

      return {
        success: false,
        warning: `Checkpoint is ${ageHours} hours old (max 24 hours)`,
      };
    }

    // AC: @restart-checkpoint ac-7
    // Version check (currently only v1 supported)
    // Note: Zod schema enforces version === 1, so this is defensive
    if (checkpoint.version !== 1) {
      log.error('Unsupported checkpoint version', {
        path: checkpointPath,
        version: String(checkpoint.version),
        supported: [1],
      });

      return {
        success: false,
        error: new Error(`Unsupported checkpoint version: ${String(checkpoint.version)}`),
      };
    }

    log.info('Checkpoint loaded', {
      path: checkpointPath,
      sessionId: checkpoint.session_id,
      reason: checkpoint.restart_reason,
    });

    return {
      success: true,
      checkpoint,
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    // AC: @restart-checkpoint ac-6
    log.error('Failed to read checkpoint', {
      path: checkpointPath,
      error: error.message,
    });

    return {
      success: false,
      error,
    };
  }
}

/**
 * Delete checkpoint file after consumption
 *
 * AC: @restart-checkpoint ac-5
 *
 * @param checkpointPath - Path to checkpoint file
 */
export async function deleteCheckpoint(checkpointPath: string): Promise<void> {
  try {
    await unlink(checkpointPath);
    log.info('Checkpoint deleted after consumption', { path: checkpointPath });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn('Failed to delete checkpoint', {
      path: checkpointPath,
      error: error.message,
    });
    // Don't throw - deletion failure is not critical
  }
}

/**
 * Result of cleanup operation
 */
export interface CleanupResult {
  deleted: number;
  errors: number;
}

/**
 * Clean up stale checkpoint files older than 24 hours
 *
 * Scans the checkpoints directory and removes files that have exceeded
 * the 24-hour TTL. Should be called on supervisor startup.
 *
 * AC: @restart-checkpoint ac-4 (implements cleanup for files that would be ignored)
 *
 * @param dataDir - Base data directory (e.g., '.kbot')
 * @returns Cleanup result with counts of deleted and errored files
 */
export async function cleanupStaleCheckpoints(dataDir: string): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, errors: 0 };
  const checkpointsDir = join(dataDir, 'checkpoints');

  try {
    const entries = await readdir(checkpointsDir);

    for (const entry of entries) {
      // Only process .yaml checkpoint files
      if (!entry.endsWith('.yaml')) {
        continue;
      }

      const filePath = join(checkpointsDir, entry);

      try {
        const fileStat = await stat(filePath);
        const age = Date.now() - fileStat.mtimeMs;

        if (age > MAX_CHECKPOINT_AGE_MS) {
          await unlink(filePath);
          result.deleted++;
          log.debug('Deleted stale checkpoint', {
            path: filePath,
            ageHours: Math.round(age / (60 * 60 * 1000)),
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.warn('Failed to clean up checkpoint', {
          path: filePath,
          error: error.message,
        });
        result.errors++;
      }
    }

    if (result.deleted > 0) {
      log.info('Cleaned up stale checkpoints', {
        deleted: result.deleted,
        errors: result.errors,
      });
    }
  } catch (err) {
    // Directory doesn't exist or can't be read - not an error condition
    const error = err instanceof Error ? err : new Error(String(err));
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Failed to scan checkpoints directory', {
        dir: checkpointsDir,
        error: error.message,
      });
    }
  }

  return result;
}
