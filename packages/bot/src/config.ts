/**
 * Bot Configuration
 *
 * Environment configuration loading and validation using Zod schemas.
 *
 * @see @bot-config
 */

import { z } from 'zod';

/**
 * Log level configuration
 */
export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * Bot configuration schema with Zod validation
 *
 * Required fields:
 * - discordToken: Discord bot token (DISCORD_TOKEN env var)
 * - agentCommand: Command to spawn agent process (AGENT_COMMAND env var)
 *
 * Optional fields with defaults:
 * - kbotDataDir: Data directory path (default: '.kbot')
 * - logLevel: Logging level (default: 'info')
 * - healthCheckInterval: Health check interval in ms (default: 30000)
 * - shutdownTimeout: Graceful shutdown timeout in ms (default: 10000)
 * - escalationChannel: Channel for escalation notifications (optional)
 *
 * Supervisor-related fields:
 * - isSupervised: Whether bot is running under supervisor (KBOT_SUPERVISED env var)
 * - supervisorPid: PID of supervisor process (KBOT_SUPERVISOR_PID env var)
 * - checkpointPath: Path to checkpoint file for restart (KBOT_CHECKPOINT_PATH env var)
 */
export const BotConfigSchema = z.object({
  // Required - no defaults
  discordToken: z
    .string({ required_error: 'DISCORD_TOKEN is required' })
    .min(1, 'DISCORD_TOKEN is required'),
  agentCommand: z
    .string({ required_error: 'AGENT_COMMAND is required' })
    .min(1, 'AGENT_COMMAND is required'),

  // Optional with defaults
  kbotDataDir: z.string().default('.kbot'),
  logLevel: LogLevelSchema.default('info'),
  healthCheckInterval: z.number().int().positive().default(30000),
  shutdownTimeout: z.number().int().positive().default(10000),

  // Optional - no defaults
  escalationChannel: z.string().optional(),

  // AC: @supervisor-env ac-3
  // Supervisor-related fields
  isSupervised: z.boolean().default(false),
  supervisorPid: z.number().int().positive().optional(),
  checkpointPath: z.string().optional(),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

/**
 * Parse an optional environment variable as a number
 *
 * @param value - The environment variable value
 * @param name - The environment variable name (for error messages)
 * @returns The parsed number or undefined if value is empty
 * @throws Error if value is present but not a valid integer
 */
function parseOptionalNumber(value: string | undefined, name: string): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || String(parsed) !== value.trim()) {
    throw new Error(`Invalid integer for ${name}: "${value}"`);
  }
  return parsed;
}

/**
 * Load and validate bot configuration from environment variables
 *
 * Environment variable mapping:
 * - DISCORD_TOKEN -> discordToken (required)
 * - AGENT_COMMAND -> agentCommand (required)
 * - KBOT_DATA_DIR -> kbotDataDir (optional, default: '.kbot')
 * - LOG_LEVEL -> logLevel (optional, default: 'info')
 * - HEALTH_CHECK_INTERVAL -> healthCheckInterval (optional, default: 30000)
 * - SHUTDOWN_TIMEOUT -> shutdownTimeout (optional, default: 10000)
 * - ESCALATION_CHANNEL -> escalationChannel (optional)
 * - KBOT_SUPERVISED -> isSupervised (optional, default: false)
 * - KBOT_SUPERVISOR_PID -> supervisorPid (optional)
 * - KBOT_CHECKPOINT_PATH -> checkpointPath (optional)
 *
 * @returns Validated bot configuration
 * @throws ZodError if validation fails
 */
export function loadConfig(): BotConfig {
  return BotConfigSchema.parse({
    discordToken: process.env.DISCORD_TOKEN,
    agentCommand: process.env.AGENT_COMMAND,
    kbotDataDir: process.env.KBOT_DATA_DIR || undefined,
    logLevel: process.env.LOG_LEVEL || undefined,
    healthCheckInterval: parseOptionalNumber(
      process.env.HEALTH_CHECK_INTERVAL,
      'HEALTH_CHECK_INTERVAL'
    ),
    shutdownTimeout: parseOptionalNumber(process.env.SHUTDOWN_TIMEOUT, 'SHUTDOWN_TIMEOUT'),
    escalationChannel: process.env.ESCALATION_CHANNEL || undefined,
    // AC: @supervisor-env ac-3
    isSupervised: process.env.KBOT_SUPERVISED === '1',
    supervisorPid: parseOptionalNumber(process.env.KBOT_SUPERVISOR_PID, 'KBOT_SUPERVISOR_PID'),
    checkpointPath: process.env.KBOT_CHECKPOINT_PATH || undefined,
  });
}
