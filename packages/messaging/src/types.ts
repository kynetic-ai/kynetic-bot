/**
 * Messaging Types
 *
 * Core types for message routing and session management.
 */

import type { NormalizedMessage, SessionKey, PeerKind } from '@kynetic-bot/core';

/**
 * Session represents an active conversation context
 *
 * A session maintains the conversation history and metadata for
 * a specific agent-peer interaction.
 */
export interface Session {
  /** Unique session key identifying this conversation */
  key: SessionKey;
  /** Agent identifier */
  agent: string;
  /** Platform name (e.g., 'whatsapp', 'telegram') */
  platform: string;
  /** Peer identifier (platform-specific user or channel ID) */
  peerId: string;
  /** Type of peer (user or channel) */
  peerKind: PeerKind;
  /** Conversation context (message history) */
  context: NormalizedMessage[];
  /** When this session was created */
  createdAt: Date;
  /** When the last activity occurred in this session */
  lastActivity: Date;
}

/**
 * SessionStore interface for session persistence
 *
 * Implementations can provide in-memory, database, or other storage backends.
 */
export interface SessionStore {
  /**
   * Retrieve a session by its key
   * @param key - Session key to look up
   * @returns Session if found, undefined otherwise
   */
  get(key: string): Session | undefined;

  /**
   * Create a new session with the given key
   * @param key - Session key for the new session
   * @param agent - Agent identifier
   * @param platform - Platform name
   * @param peerId - Peer identifier
   * @param peerKind - Peer kind (user or channel)
   * @returns The newly created session
   */
  create(
    key: string,
    agent: string,
    platform: string,
    peerId: string,
    peerKind: PeerKind,
  ): Session;

  /**
   * Delete a session by its key
   * @param key - Session key to delete
   */
  delete(key: string): void;
}
