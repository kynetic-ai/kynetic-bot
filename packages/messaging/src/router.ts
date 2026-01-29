/**
 * Session Key Router
 *
 * Routes messages to sessions based on session keys and manages session lifecycle.
 */

import type { NormalizedMessage } from '@kynetic-bot/core';
import {
  buildSessionKey,
  UnknownAgentError,
} from '@kynetic-bot/core';
import type { Session, SessionStore } from './types.js';

/**
 * Result type for operations that can fail
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * SessionKeyRouter handles message routing and session management
 *
 * Routes incoming messages to appropriate sessions based on session keys,
 * maintaining conversation context and handling idempotency.
 */
export class SessionKeyRouter {
  constructor(
    private readonly store: SessionStore,
    private readonly validAgents: Set<string>,
  ) {}

  /**
   * Resolve a session for an incoming message
   *
   * Creates a new session if one doesn't exist for the session key.
   * Returns an error if the agent is unknown.
   *
   * @param message - Normalized message to route
   * @param agentId - Target agent identifier
   * @returns Result with session or error
   */
  resolveSession(
    message: NormalizedMessage,
    agentId: string,
  ): Result<Session, UnknownAgentError> {
    // AC-3: Unknown agent should return error
    if (!this.validAgents.has(agentId)) {
      return {
        ok: false,
        error: new UnknownAgentError(agentId, {
          message: message.id,
          platform: message.sender.platform,
        }),
      };
    }

    // AC-1: Build unique session key from message and agent
    const sessionKey = buildSessionKey({
      agent: agentId,
      platform: message.sender.platform,
      peerKind: 'user', // Messages from users are always 'user' kind
      peerId: message.sender.id,
    });

    // AC-2: Get or create session, append message to context
    const session = this.getOrCreateSession(
      sessionKey,
      agentId,
      message.sender.platform,
      message.sender.id,
      'user',
    );

    // AC-4: Idempotent - check if message already in context
    const isDuplicate = session.context.some((m) => m.id === message.id);
    if (!isDuplicate) {
      session.context.push(message);
      session.lastActivity = new Date();
    }

    return { ok: true, value: session };
  }

  /**
   * Get an existing session or create a new one
   *
   * @param key - Session key
   * @param agent - Agent identifier
   * @param platform - Platform name
   * @param peerId - Peer identifier
   * @param peerKind - Peer kind (user or channel)
   * @returns Session instance
   */
  getOrCreateSession(
    key: string,
    agent: string,
    platform: string,
    peerId: string,
    peerKind: 'user' | 'channel',
  ): Session {
    const existing = this.store.get(key);
    if (existing) {
      return existing;
    }

    return this.store.create(key, agent, platform, peerId, peerKind);
  }

  /**
   * Close and remove a session
   *
   * @param key - Session key to close
   */
  closeSession(key: string): void {
    this.store.delete(key);
  }

  /**
   * Add an agent to the set of valid agents
   *
   * @param agentId - Agent identifier to add
   */
  addAgent(agentId: string): void {
    this.validAgents.add(agentId);
  }

  /**
   * Remove an agent from the set of valid agents
   *
   * @param agentId - Agent identifier to remove
   */
  removeAgent(agentId: string): void {
    this.validAgents.delete(agentId);
  }

  /**
   * Check if an agent is valid
   *
   * @param agentId - Agent identifier to check
   * @returns True if agent is valid, false otherwise
   */
  hasAgent(agentId: string): boolean {
    return this.validAgents.has(agentId);
  }
}
