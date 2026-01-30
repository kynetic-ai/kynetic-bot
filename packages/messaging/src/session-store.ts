/**
 * InMemorySessionStore - Volatile session storage
 *
 * Implements the SessionStore interface with in-memory Map storage.
 * Suitable for development, testing, and single-instance deployments
 * where session persistence across restarts is not required.
 */

import type { SessionKey, PeerKind } from '@kynetic-bot/core';
import type { Session, SessionStore } from './types.js';

/**
 * In-memory session store implementation
 *
 * Sessions are stored in a Map and will be lost on process restart.
 * For persistent storage, use a database-backed implementation.
 */
export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  get(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  create(
    key: string,
    agent: string,
    platform: string,
    peerId: string,
    peerKind: PeerKind,
  ): Session {
    const session: Session = {
      key: key as SessionKey,
      agent,
      platform,
      peerId,
      peerKind,
      context: [],
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessions.set(key, session);
    return session;
  }

  delete(key: string): void {
    this.sessions.delete(key);
  }

  /**
   * Clear all sessions (primarily for testing)
   */
  clear(): void {
    this.sessions.clear();
  }

  /**
   * Get the number of active sessions
   */
  get size(): number {
    return this.sessions.size;
  }
}
