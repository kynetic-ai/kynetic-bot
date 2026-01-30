/**
 * Bot Identity System
 *
 * Loads and formats the kbot identity for system prompt injection.
 * Supports base identity with optional customization via .kbot/identity.yaml.
 *
 * @see @bot-identity
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import yaml from 'yaml';
import { createLogger } from '@kynetic-bot/core';

const log = createLogger('identity');

/**
 * Schema for custom identity configuration (.kbot/identity.yaml)
 */
export const CustomIdentitySchema = z.object({
  name: z.string().optional(),
  role: z.string().optional(),
  boundaries: z.array(z.string()).optional(),
  traits: z.array(z.string()).optional(),
}).partial();

export type CustomIdentity = z.infer<typeof CustomIdentitySchema>;

/**
 * Base identity string that establishes kbot as a persistent assistant.
 * This is always prepended to the system prompt.
 *
 * AC: @bot-identity ac-1
 */
const BASE_IDENTITY = `You are kynetic-bot, a persistent general assistant.

Key traits:
- You maintain memory and context across sessions
- You have full system access via Claude Code tools
- You are helpful, direct, and remember past conversations`;

/**
 * Load custom identity from .kbot/identity.yaml if it exists.
 *
 * @param kbotDataDir - Path to the .kbot data directory
 * @returns Custom identity object or null if file doesn't exist
 *
 * AC: @bot-identity ac-2, ac-3
 */
export async function loadCustomIdentity(kbotDataDir: string): Promise<CustomIdentity | null> {
  const identityPath = path.join(kbotDataDir, 'identity.yaml');

  try {
    const content = await fs.readFile(identityPath, 'utf8');
    const parsed = yaml.parse(content);
    const validated = CustomIdentitySchema.parse(parsed);
    log.info('Loaded custom identity', { path: identityPath });
    return validated;
  } catch (err) {
    // File doesn't exist - not an error, just no custom identity
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      log.debug('No custom identity file found', { path: identityPath });
      return null;
    }

    // Other errors (parse errors, validation errors) are logged as warnings
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn('Failed to load custom identity', { path: identityPath, error: error.message });
    return null;
  }
}

/**
 * Format custom identity into a string for system prompt injection.
 *
 * @param custom - Custom identity configuration
 * @returns Formatted identity string
 */
function formatCustomIdentity(custom: CustomIdentity): string {
  const parts: string[] = [];

  if (custom.name) {
    parts.push(`Name: ${custom.name}`);
  }

  if (custom.role) {
    parts.push(`Role: ${custom.role}`);
  }

  if (custom.boundaries && custom.boundaries.length > 0) {
    parts.push('Boundaries:');
    for (const boundary of custom.boundaries) {
      parts.push(`- ${boundary}`);
    }
  }

  if (custom.traits && custom.traits.length > 0) {
    parts.push('Traits:');
    for (const trait of custom.traits) {
      parts.push(`- ${trait}`);
    }
  }

  return parts.join('\n');
}

/**
 * Build the complete identity string for system prompt injection.
 *
 * Always includes base identity. If custom identity exists, appends it
 * after the base identity with a separator.
 *
 * @param kbotDataDir - Path to the .kbot data directory
 * @returns Complete identity string for system prompt
 *
 * AC: @bot-identity ac-1, ac-2, ac-3
 */
export async function buildIdentityPrompt(kbotDataDir: string): Promise<string> {
  const custom = await loadCustomIdentity(kbotDataDir);

  if (!custom) {
    // AC: @bot-identity ac-3 - No custom identity, use base only
    return BASE_IDENTITY;
  }

  // AC: @bot-identity ac-2 - Custom identity exists, append after base
  const customFormatted = formatCustomIdentity(custom);
  if (!customFormatted) {
    return BASE_IDENTITY;
  }

  return `${BASE_IDENTITY}

Custom Configuration:
${customFormatted}`;
}

/**
 * Get the base identity string (for testing or direct access).
 */
export function getBaseIdentity(): string {
  return BASE_IDENTITY;
}
