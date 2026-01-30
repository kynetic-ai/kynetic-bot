/**
 * ConversationStore Tests
 *
 * Tests for conversation storage with JSONL turn logs.
 *
 * @see @mem-conversation
 */

import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { ulid } from 'ulid';

import {
  ConversationStore,
  ConversationStoreError,
  ConversationValidationError,
} from '../src/store/conversation-store.js';
import { SessionStore } from '../src/store/session-store.js';
import type { ConversationTurn } from '../src/types/conversation.js';

describe('ConversationStore', () => {
  let tempDir: string;
  let store: ConversationStore;
  let emitter: EventEmitter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-store-test-'));
    emitter = new EventEmitter();
    store = new ConversationStore({ baseDir: tempDir, emitter });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('createConversation', () => {
    // AC: @mem-conversation ac-1 - creates conversation with turns.jsonl
    it('creates conversation directory with conversation.yaml and turns.jsonl', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      expect(conversation.session_key).toBe(sessionKey);
      expect(conversation.status).toBe('active');
      expect(conversation.turn_count).toBe(0);

      // Check files created
      const convDir = path.join(tempDir, 'conversations', conversation.id);
      expect(existsSync(convDir)).toBe(true);
      expect(existsSync(path.join(convDir, 'conversation.yaml'))).toBe(true);
      expect(existsSync(path.join(convDir, 'turns.jsonl'))).toBe(true);

      // Verify conversation.yaml content
      const yamlContent = readFileSync(path.join(convDir, 'conversation.yaml'), 'utf-8');
      const parsed = yamlParse(yamlContent);
      expect(parsed.session_key).toBe(sessionKey);
      expect(parsed.status).toBe('active');
    });

    it('auto-assigns timestamps', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      expect(conversation.created_at).toBeDefined();
      expect(conversation.updated_at).toBeDefined();
      expect(new Date(conversation.created_at).getTime()).toBeLessThanOrEqual(Date.now());
    });

    // AC: @trait-observable ac-1 - emits structured event
    it('emits conversation:created event', async () => {
      const events: Array<{ conversation: unknown }> = [];
      emitter.on('conversation:created', (data) => events.push(data));

      const conversation = await store.createConversation('discord:dm:user123');

      expect(events).toHaveLength(1);
      expect(events[0].conversation).toEqual(conversation);
    });

    it('adds conversation to session key index', async () => {
      const sessionKey = 'discord:dm:user456';
      const conversation = await store.createConversation(sessionKey);

      // Verify index
      const indexPath = path.join(tempDir, 'conversations', 'session-key-index.json');
      const index = JSON.parse(readFileSync(indexPath, 'utf-8'));
      expect(index[sessionKey]).toBe(conversation.id);
    });
  });

  describe('getConversation', () => {
    it('returns conversation metadata', async () => {
      const sessionKey = 'discord:dm:user123';
      const created = await store.createConversation(sessionKey);

      const conversation = await store.getConversation(created.id);
      expect(conversation).not.toBeNull();
      expect(conversation?.id).toBe(created.id);
      expect(conversation?.session_key).toBe(sessionKey);
    });

    it('returns null for non-existent conversation', async () => {
      const conversation = await store.getConversation('nonexistent');
      expect(conversation).toBeNull();
    });
  });

  describe('getConversationBySessionKey', () => {
    it('returns conversation for session key', async () => {
      const sessionKey = 'discord:dm:user789';
      const created = await store.createConversation(sessionKey);

      const conversation = await store.getConversationBySessionKey(sessionKey);
      expect(conversation).not.toBeNull();
      expect(conversation?.id).toBe(created.id);
    });

    it('returns null for unknown session key', async () => {
      const conversation = await store.getConversationBySessionKey('unknown:key');
      expect(conversation).toBeNull();
    });
  });

  describe('getOrCreateConversation', () => {
    it('returns existing conversation', async () => {
      const sessionKey = 'discord:dm:user123';
      const created = await store.createConversation(sessionKey);

      const conversation = await store.getOrCreateConversation(sessionKey);
      expect(conversation.id).toBe(created.id);
    });

    it('creates new conversation if not exists', async () => {
      const sessionKey = 'discord:dm:newuser';

      const conversation = await store.getOrCreateConversation(sessionKey);
      expect(conversation.session_key).toBe(sessionKey);
      expect(conversation.status).toBe('active');
    });
  });

  describe('conversationExists', () => {
    it('returns true for existing conversation', async () => {
      const conversation = await store.createConversation('discord:dm:user123');
      expect(await store.conversationExists(conversation.id)).toBe(true);
    });

    it('returns false for non-existent conversation', async () => {
      expect(await store.conversationExists('nonexistent')).toBe(false);
    });
  });

  describe('listConversations', () => {
    it('returns empty array when no conversations', async () => {
      const conversations = await store.listConversations();
      expect(conversations).toEqual([]);
    });

    it('returns all conversations', async () => {
      await store.createConversation('discord:dm:user1');
      await store.createConversation('discord:dm:user2');

      const conversations = await store.listConversations();
      expect(conversations).toHaveLength(2);
    });

    it('filters by status', async () => {
      const active = await store.createConversation('discord:dm:user1');
      const archived = await store.createConversation('discord:dm:user2');
      await store.archiveConversation(archived.id);

      const activeConvs = await store.listConversations({ status: 'active' });
      expect(activeConvs).toHaveLength(1);
      expect(activeConvs[0].id).toBe(active.id);

      const archivedConvs = await store.listConversations({ status: 'archived' });
      expect(archivedConvs).toHaveLength(1);
      expect(archivedConvs[0].id).toBe(archived.id);
    });

    it('respects limit option', async () => {
      await store.createConversation('discord:dm:user1');
      await store.createConversation('discord:dm:user2');
      await store.createConversation('discord:dm:user3');

      const conversations = await store.listConversations({ limit: 2 });
      expect(conversations).toHaveLength(2);
    });
  });

  describe('archiveConversation', () => {
    it('sets status to archived', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      const archived = await store.archiveConversation(conversation.id);

      expect(archived?.status).toBe('archived');
    });

    it('updates updated_at timestamp', async () => {
      const conversation = await store.createConversation('discord:dm:user123');
      const originalUpdatedAt = conversation.updated_at;

      // Wait a tiny bit to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));

      const archived = await store.archiveConversation(conversation.id);

      expect(archived?.updated_at).not.toBe(originalUpdatedAt);
    });

    it('emits conversation:archived event', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      const events: Array<{ conversationId: string }> = [];
      emitter.on('conversation:archived', (data) => events.push(data));

      await store.archiveConversation(conversation.id);

      expect(events).toHaveLength(1);
      expect(events[0].conversationId).toBe(conversation.id);
    });

    it('returns null for non-existent conversation', async () => {
      const result = await store.archiveConversation('nonexistent');
      expect(result).toBeNull();
    });

    it('persists status change', async () => {
      const conversation = await store.createConversation('discord:dm:user123');
      await store.archiveConversation(conversation.id);

      // Read fresh from disk
      const loaded = await store.getConversation(conversation.id);
      expect(loaded?.status).toBe('archived');
    });
  });

  describe('appendTurn', () => {
    // AC: @mem-conversation ac-1 - creates turn with role, content, ts, seq
    it('appends turn with auto-assigned ts and seq', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      const beforeTs = Date.now();
      const turn = await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello!',
      });
      const afterTs = Date.now();

      expect(turn.seq).toBe(0);
      expect(turn.ts).toBeGreaterThanOrEqual(beforeTs);
      expect(turn.ts).toBeLessThanOrEqual(afterTs);
      expect(turn.role).toBe('user');
      expect(turn.content).toBe('Hello!');
    });

    it('increments seq for each turn', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      const t1 = await store.appendTurn(conversation.id, { role: 'user', content: 'Hi' });
      const t2 = await store.appendTurn(conversation.id, { role: 'assistant', content: 'Hello!' });
      const t3 = await store.appendTurn(conversation.id, { role: 'user', content: 'How are you?' });

      expect(t1.seq).toBe(0);
      expect(t2.seq).toBe(1);
      expect(t3.seq).toBe(2);
    });

    // AC: @mem-conversation ac-2 - links assistant turns to agent sessions
    it('accepts agent_session_id for assistant turns', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      const turn = await store.appendTurn(conversation.id, {
        role: 'assistant',
        content: 'Hello!',
        agent_session_id: '01SESSION123',
      });

      expect(turn.agent_session_id).toBe('01SESSION123');
    });

    // AC: @mem-conversation ac-4 - idempotent by message_id
    it('returns existing turn for duplicate message_id', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      const turn1 = await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello!',
        message_id: 'msg-123',
      });

      const turn2 = await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Different content',
        message_id: 'msg-123',
      });

      // Should return the original turn
      expect(turn2.seq).toBe(turn1.seq);
      expect(turn2.content).toBe(turn1.content);

      // Should only have one turn
      const turns = await store.readTurns(conversation.id);
      expect(turns).toHaveLength(1);
    });

    it('emits turn:appended with wasDuplicate=true for duplicates', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello!',
        message_id: 'msg-123',
      });

      const events: Array<{ wasDuplicate: boolean }> = [];
      emitter.on('turn:appended', (data) => events.push(data));

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Different',
        message_id: 'msg-123',
      });

      expect(events).toHaveLength(1);
      expect(events[0].wasDuplicate).toBe(true);
    });

    // AC: @mem-conversation ac-5 - emits turn_appended event
    it('emits turn:appended event', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      const events: Array<{ conversationId: string; turn: ConversationTurn }> = [];
      emitter.on('turn:appended', (data) => events.push(data));

      const turn = await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello!',
      });

      expect(events).toHaveLength(1);
      expect(events[0].conversationId).toBe(conversation.id);
      expect(events[0].turn).toEqual(turn);
    });

    it('updates conversation turn_count', async () => {
      const conversation = await store.createConversation('discord:dm:user123');
      expect(conversation.turn_count).toBe(0);

      await store.appendTurn(conversation.id, { role: 'user', content: 'Hi' });

      const updated = await store.getConversation(conversation.id);
      expect(updated?.turn_count).toBe(1);

      await store.appendTurn(conversation.id, { role: 'assistant', content: 'Hello!' });

      const updated2 = await store.getConversation(conversation.id);
      expect(updated2?.turn_count).toBe(2);
    });

    it('throws ConversationStoreError for non-existent conversation', async () => {
      await expect(
        store.appendTurn('nonexistent', {
          role: 'user',
          content: 'Hello!',
        }),
      ).rejects.toThrow(ConversationStoreError);
    });

    // AC: @mem-conversation ac-6 - rejects with Zod validation error
    it('throws ConversationValidationError for invalid turn', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      await expect(
        store.appendTurn(conversation.id, {
          role: 'invalid-role' as any,
          content: 'Hello!',
        }),
      ).rejects.toThrow(ConversationValidationError);
    });

    // AC: @mem-conversation ac-7 - validates agent_session_id references
    it('validates agent_session_id when sessionStore provided', async () => {
      // Create a store with sessionStore
      const sessionStore = new SessionStore({ baseDir: tempDir });
      const storeWithSessionValidation = new ConversationStore({
        baseDir: tempDir,
        sessionStore,
        emitter,
      });

      const conversation = await storeWithSessionValidation.createConversation('discord:dm:test');

      // Should throw for non-existent session
      await expect(
        storeWithSessionValidation.appendTurn(conversation.id, {
          role: 'assistant',
          content: 'Hello!',
          agent_session_id: 'nonexistent-session',
        }),
      ).rejects.toThrow(ConversationStoreError);
    });

    it('allows valid agent_session_id when sessionStore provided', async () => {
      const sessionStore = new SessionStore({ baseDir: tempDir });
      const storeWithSessionValidation = new ConversationStore({
        baseDir: tempDir,
        sessionStore,
        emitter,
      });

      // Create a valid session
      const session = await sessionStore.createSession({
        id: ulid(),
        agent_type: 'claude',
      });

      const conversation = await storeWithSessionValidation.createConversation('discord:dm:test');

      // Should succeed with valid session
      const turn = await storeWithSessionValidation.appendTurn(conversation.id, {
        role: 'assistant',
        content: 'Hello!',
        agent_session_id: session.id,
      });

      expect(turn.agent_session_id).toBe(session.id);
    });

    it('persists turn to turns.jsonl', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello!',
      });

      // Read directly from file
      const turnsPath = path.join(tempDir, 'conversations', conversation.id, 'turns.jsonl');
      const content = readFileSync(turnsPath, 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.role).toBe('user');
      expect(parsed.content).toBe('Hello!');
    });

    it('handles sequential turn appends with locking', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      // Append turns sequentially - locking ensures proper ordering
      for (let i = 0; i < 5; i++) {
        await store.appendTurn(conversation.id, {
          role: 'user',
          content: `Message ${i}`,
        });
      }

      // All turns should have unique sequence numbers
      const turns = await store.readTurns(conversation.id);
      const seqs = turns.map((t) => t.seq);
      const uniqueSeqs = new Set(seqs);
      expect(uniqueSeqs.size).toBe(5);

      // Verify turn count
      const updated = await store.getConversation(conversation.id);
      expect(updated?.turn_count).toBe(5);
    });

    it('handles concurrent turn appends safely', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      // Append many turns concurrently
      const concurrentAppends = Array.from({ length: 10 }, (_, i) =>
        store.appendTurn(conversation.id, {
          role: 'user',
          content: `Concurrent message ${i}`,
        }),
      );

      const results = await Promise.all(concurrentAppends);

      // All turns should have unique sequence numbers
      const seqs = results.map((t) => t.seq);
      const uniqueSeqs = new Set(seqs);
      expect(uniqueSeqs.size).toBe(10);

      // Read back and verify
      const turns = await store.readTurns(conversation.id);
      expect(turns).toHaveLength(10);

      // Verify turn count
      const updated = await store.getConversation(conversation.id);
      expect(updated?.turn_count).toBe(10);
    });
  });

  describe('readTurns', () => {
    it('returns turns sorted by seq', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      // Append with explicit out-of-order seq
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Third',
        seq: 2,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'First',
        seq: 0,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Second',
        seq: 1,
      });

      const turns = await store.readTurns(conversation.id);

      expect(turns).toHaveLength(3);
      expect(turns[0].seq).toBe(0);
      expect(turns[1].seq).toBe(1);
      expect(turns[2].seq).toBe(2);
    });

    it('returns empty array for conversation with no turns', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      const turns = await store.readTurns(conversation.id);
      expect(turns).toEqual([]);
    });

    it('returns empty array for non-existent conversation', async () => {
      const turns = await store.readTurns('nonexistent');
      expect(turns).toEqual([]);
    });

    // AC: @mem-conversation ac-3 - skips invalid JSON lines with warning
    it('skips invalid JSON lines with warning', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Valid turn',
      });

      // Manually append invalid JSON line
      const turnsPath = path.join(tempDir, 'conversations', conversation.id, 'turns.jsonl');
      await fs.appendFile(turnsPath, 'invalid json line\n', 'utf-8');

      await store.appendTurn(conversation.id, {
        role: 'assistant',
        content: 'Another valid turn',
      });

      const errors: Array<{ error: Error }> = [];
      emitter.on('error', (data) => errors.push(data));

      const turns = await store.readTurns(conversation.id);

      expect(turns).toHaveLength(2);
      expect(errors).toHaveLength(1);
      expect(errors[0].error.message).toContain('JSON errors');
    });

    it('skips lines that fail schema validation', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Valid turn',
      });

      // Manually append valid JSON but invalid turn schema
      const turnsPath = path.join(tempDir, 'conversations', conversation.id, 'turns.jsonl');
      await fs.appendFile(turnsPath, '{"not": "a valid turn"}\n', 'utf-8');

      const errors: Array<{ error: Error }> = [];
      emitter.on('error', (data) => errors.push(data));

      const turns = await store.readTurns(conversation.id);

      expect(turns).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].error.message).toContain('schema validation');
    });
  });

  describe('readTurnsSince', () => {
    it('returns turns within time range', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Early',
        ts: 1000,
        seq: 0,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Middle',
        ts: 2000,
        seq: 1,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Late',
        ts: 3000,
        seq: 2,
      });

      const sinceTurns = await store.readTurnsSince(conversation.id, 1500);
      expect(sinceTurns).toHaveLength(2);
      expect(sinceTurns[0].ts).toBe(2000);
      expect(sinceTurns[1].ts).toBe(3000);

      const rangeTurns = await store.readTurnsSince(conversation.id, 1500, 2500);
      expect(rangeTurns).toHaveLength(1);
      expect(rangeTurns[0].ts).toBe(2000);
    });
  });

  describe('getLastTurn', () => {
    it('returns last turn by seq', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      await store.appendTurn(conversation.id, { role: 'user', content: 'First' });
      await store.appendTurn(conversation.id, { role: 'assistant', content: 'Second' });

      const lastTurn = await store.getLastTurn(conversation.id);

      expect(lastTurn).not.toBeNull();
      expect(lastTurn?.role).toBe('assistant');
      expect(lastTurn?.seq).toBe(1);
    });

    it('returns null for conversation with no turns', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      const lastTurn = await store.getLastTurn(conversation.id);
      expect(lastTurn).toBeNull();
    });
  });

  describe('getTurnCount', () => {
    it('returns number of turns', async () => {
      const conversation = await store.createConversation('discord:dm:user123');

      expect(await store.getTurnCount(conversation.id)).toBe(0);

      await store.appendTurn(conversation.id, { role: 'user', content: 'Hi' });
      expect(await store.getTurnCount(conversation.id)).toBe(1);

      await store.appendTurn(conversation.id, { role: 'assistant', content: 'Hello!' });
      expect(await store.getTurnCount(conversation.id)).toBe(2);
    });

    it('returns 0 for non-existent conversation', async () => {
      expect(await store.getTurnCount('nonexistent')).toBe(0);
    });
  });
});
