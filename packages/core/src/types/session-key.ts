/**
 * Session Key Types
 *
 * Session keys uniquely identify a conversation between an agent and a peer (user or channel).
 * Format: agent:{agentId}:{platform}:{peerKind}:{peerId}
 * Example: agent:main:whatsapp:user:+1234567890
 */

/**
 * Peer kind - whether the session is with a user or a channel
 */
export type PeerKind = 'user' | 'channel';

/**
 * Parsed session key structure
 */
export interface ParsedSessionKey {
  /** Agent identifier */
  agent: string;
  /** Platform name (e.g., 'whatsapp', 'telegram', 'discord') */
  platform: string;
  /** Whether the peer is a user or channel */
  peerKind: PeerKind;
  /** Peer identifier (platform-specific) */
  peerId: string;
}

/**
 * Session key string type (branded for type safety)
 * Format: agent:{agentId}:{platform}:{peerKind}:{peerId}
 */
export type SessionKey = string & { readonly __brand: 'SessionKey' };
