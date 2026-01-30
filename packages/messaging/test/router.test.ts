/**
 * SessionKeyRouter Tests
 *
 * Test coverage for message routing and session management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionKeyRouter, InMemorySessionStore } from '../src/index.js';
import type { NormalizedMessage } from '@kynetic-bot/core';
import { UnknownAgentError } from '@kynetic-bot/core';

/**
 * Create a mock normalized message
 */
function createMockMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: 'msg-123',
    text: 'Hello',
    sender: {
      id: '+1234567890',
      platform: 'whatsapp',
      displayName: 'Test User',
    },
    timestamp: new Date(),
    channel: 'test-channel',
    metadata: {},
    ...overrides,
  };
}

describe('SessionKeyRouter', () => {
  let store: InMemorySessionStore;
  let router: SessionKeyRouter;

  beforeEach(() => {
    store = new InMemorySessionStore();
    router = new SessionKeyRouter(store, new Set(['main', 'support']));
  });

  describe('Message Routing (@msg-routing)', () => {
    // AC: @msg-routing ac-1
    it('should resolve to unique session key based on user and agent IDs', () => {
      const message = createMockMessage({
        sender: { id: '+1234567890', platform: 'whatsapp' },
      });

      const result = router.resolveSession(message, 'main');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.key).toBe('agent:main:whatsapp:user:+1234567890');
        expect(result.value.agent).toBe('main');
        expect(result.value.platform).toBe('whatsapp');
        expect(result.value.peerId).toBe('+1234567890');
        expect(result.value.peerKind).toBe('user');
      }
    });

    // AC: @msg-routing ac-2
    it('should append message to existing conversation context', () => {
      const message1 = createMockMessage({
        id: 'msg-1',
        text: 'First message',
        sender: { id: '+1234567890', platform: 'whatsapp' },
      });
      const message2 = createMockMessage({
        id: 'msg-2',
        text: 'Second message',
        sender: { id: '+1234567890', platform: 'whatsapp' },
      });

      // First message creates session
      const result1 = router.resolveSession(message1, 'main');
      expect(result1.ok).toBe(true);

      // Second message should append to same session
      const result2 = router.resolveSession(message2, 'main');
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Should be the same session
        expect(result2.value.key).toBe(result1.value.key);
        // Context should have both messages
        expect(result2.value.context).toHaveLength(2);
        expect(result2.value.context[0].id).toBe('msg-1');
        expect(result2.value.context[1].id).toBe('msg-2');
      }
    });

    // AC: @msg-routing ac-3
    it('should return error with unknown agent code', () => {
      const message = createMockMessage();

      const result = router.resolveSession(message, 'unknown-agent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(UnknownAgentError);
        expect(result.error.code).toBe('UNKNOWN_AGENT');
        expect(result.error.context?.agentId).toBe('unknown-agent');
      }
    });

    // AC: @msg-routing ac-4
    it('should return same session without duplicate context for duplicate message', () => {
      const message = createMockMessage({
        id: 'msg-duplicate',
        text: 'Hello',
      });

      // Send message twice
      const result1 = router.resolveSession(message, 'main');
      const result2 = router.resolveSession(message, 'main');

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        // Should be same session
        expect(result2.value.key).toBe(result1.value.key);
        // Context should have message only once
        expect(result2.value.context).toHaveLength(1);
        expect(result2.value.context[0].id).toBe('msg-duplicate');
      }
    });
  });

  describe('Session Management', () => {
    it('should create new session if one does not exist', () => {
      const session = router.getOrCreateSession(
        'agent:main:whatsapp:user:+1234567890',
        'main',
        'whatsapp',
        '+1234567890',
        'user',
      );

      expect(session).toBeDefined();
      expect(session.key).toBe('agent:main:whatsapp:user:+1234567890');
      expect(session.context).toHaveLength(0);
    });

    it('should return existing session if one exists', () => {
      const key = 'agent:main:whatsapp:user:+1234567890';

      // Create session
      const session1 = router.getOrCreateSession(key, 'main', 'whatsapp', '+1234567890', 'user');
      session1.context.push(createMockMessage());

      // Get same session
      const session2 = router.getOrCreateSession(key, 'main', 'whatsapp', '+1234567890', 'user');

      expect(session2).toBe(session1);
      expect(session2.context).toHaveLength(1);
    });

    it('should close and remove session', () => {
      const key = 'agent:main:whatsapp:user:+1234567890';

      router.getOrCreateSession(key, 'main', 'whatsapp', '+1234567890', 'user');
      expect(store.get(key)).toBeDefined();

      router.closeSession(key);
      expect(store.get(key)).toBeUndefined();
    });
  });

  describe('Agent Management', () => {
    it('should add agent to valid agents', () => {
      expect(router.hasAgent('new-agent')).toBe(false);

      router.addAgent('new-agent');

      expect(router.hasAgent('new-agent')).toBe(true);
    });

    it('should remove agent from valid agents', () => {
      expect(router.hasAgent('main')).toBe(true);

      router.removeAgent('main');

      expect(router.hasAgent('main')).toBe(false);
    });

    it('should allow routing to newly added agent', () => {
      router.addAgent('custom-agent');
      const message = createMockMessage();

      const result = router.resolveSession(message, 'custom-agent');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.agent).toBe('custom-agent');
      }
    });
  });

  describe('Different platforms and users', () => {
    it('should create separate sessions for different platforms', () => {
      const whatsappMsg = createMockMessage({
        sender: { id: 'user123', platform: 'whatsapp' },
      });
      const telegramMsg = createMockMessage({
        sender: { id: 'user123', platform: 'telegram' },
      });

      const result1 = router.resolveSession(whatsappMsg, 'main');
      const result2 = router.resolveSession(telegramMsg, 'main');

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        expect(result1.value.key).not.toBe(result2.value.key);
        expect(result1.value.key).toContain('whatsapp');
        expect(result2.value.key).toContain('telegram');
      }
    });

    it('should create separate sessions for different users', () => {
      const user1Msg = createMockMessage({
        sender: { id: 'user1', platform: 'whatsapp' },
      });
      const user2Msg = createMockMessage({
        sender: { id: 'user2', platform: 'whatsapp' },
      });

      const result1 = router.resolveSession(user1Msg, 'main');
      const result2 = router.resolveSession(user2Msg, 'main');

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        expect(result1.value.key).not.toBe(result2.value.key);
        expect(result1.value.key).toContain('user1');
        expect(result2.value.key).toContain('user2');
      }
    });

    it('should create separate sessions for different agents', () => {
      const message = createMockMessage({
        sender: { id: 'user123', platform: 'whatsapp' },
      });

      const result1 = router.resolveSession(message, 'main');
      const result2 = router.resolveSession(message, 'support');

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        expect(result1.value.key).not.toBe(result2.value.key);
        expect(result1.value.agent).toBe('main');
        expect(result2.value.agent).toBe('support');
      }
    });
  });

  describe('Session timestamps', () => {
    it('should update lastActivity when new message is added', async () => {
      const message1 = createMockMessage({ id: 'msg-1' });

      const result1 = router.resolveSession(message1, 'main');
      expect(result1.ok).toBe(true);

      if (result1.ok) {
        const firstActivity = result1.value.lastActivity;

        // Wait a bit to ensure timestamp difference
        await new Promise((resolve) => setTimeout(resolve, 10));

        const message2 = createMockMessage({ id: 'msg-2' });
        const result2 = router.resolveSession(message2, 'main');

        expect(result2.ok).toBe(true);
        if (result2.ok) {
          expect(result2.value.lastActivity.getTime()).toBeGreaterThan(
            firstActivity.getTime(),
          );
        }
      }
    });

    it('should not update lastActivity for duplicate messages', async () => {
      const message = createMockMessage({ id: 'msg-duplicate' });

      const result1 = router.resolveSession(message, 'main');
      expect(result1.ok).toBe(true);

      if (result1.ok) {
        const firstActivity = result1.value.lastActivity;

        // Wait a bit to ensure timestamp difference would occur if updated
        await new Promise((resolve) => setTimeout(resolve, 10));

        const result2 = router.resolveSession(message, 'main');

        expect(result2.ok).toBe(true);
        if (result2.ok) {
          // Should be exactly the same timestamp (not updated)
          expect(result2.value.lastActivity.getTime()).toBe(firstActivity.getTime());
        }
      }
    });
  });
});
