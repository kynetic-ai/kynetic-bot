/**
 * Session Key Utilities
 *
 * Functions for parsing and building session keys.
 * Format: agent:{agentId}:{platform}:{peerKind}:{peerId}
 */

import type { ParsedSessionKey, PeerKind, SessionKey } from '../types/session-key.js';
import { InvalidSessionKeyError } from './errors.js';

const SESSION_KEY_PATTERN = /^agent:([^:]+):([^:]+):(user|channel):(.+)$/;

/**
 * Parse a session key string into its components
 *
 * @param key - Session key string to parse
 * @returns Parsed session key structure
 * @throws {InvalidSessionKeyError} If the key format is invalid
 *
 * @example
 * parseSessionKey('agent:main:whatsapp:user:+1234567890')
 * // Returns: { agent: 'main', platform: 'whatsapp', peerKind: 'user', peerId: '+1234567890' }
 */
export function parseSessionKey(key: string): ParsedSessionKey {
  const match = SESSION_KEY_PATTERN.exec(key);

  if (!match) {
    throw new InvalidSessionKeyError(
      key,
      'Must match format: agent:{agentId}:{platform}:{peerKind}:{peerId}',
    );
  }

  const [, agent, platform, peerKind, peerId] = match;

  // Additional validation
  if (!agent || !platform || !peerId) {
    throw new InvalidSessionKeyError(key, 'Missing required segment');
  }

  return {
    agent,
    platform,
    peerKind: peerKind as PeerKind,
    peerId,
  };
}

/**
 * Build a session key string from its components
 *
 * @param parts - Parsed session key structure
 * @returns Formatted session key string
 *
 * @example
 * buildSessionKey({ agent: 'main', platform: 'whatsapp', peerKind: 'user', peerId: '+1234567890' })
 * // Returns: 'agent:main:whatsapp:user:+1234567890'
 */
export function buildSessionKey(parts: ParsedSessionKey): SessionKey {
  const { agent, platform, peerKind, peerId } = parts;

  // Validate parts
  if (!agent || !platform || !peerKind || !peerId) {
    throw new Error('All session key parts are required (agent, platform, peerKind, peerId)');
  }

  if (peerKind !== 'user' && peerKind !== 'channel') {
    throw new Error(`Invalid peerKind: ${peerKind}. Must be 'user' or 'channel'`);
  }

  return `agent:${agent}:${platform}:${peerKind}:${peerId}` as SessionKey;
}

/**
 * Check if a string is a valid session key format
 *
 * @param key - String to validate
 * @returns true if the key is valid, false otherwise
 */
export function isValidSessionKey(key: string): key is SessionKey {
  try {
    parseSessionKey(key);
    return true;
  } catch {
    return false;
  }
}
