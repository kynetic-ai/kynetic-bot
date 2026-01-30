/**
 * ConversationHistory Tests
 *
 * Tests for conversation history management with semantic boundary detection.
 *
 * @see @msg-history
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConversationStore } from '@kynetic-bot/memory';
import { ConversationHistory, type HistoryOptions } from '../src/history.js';

describe('ConversationHistory', () => {
  let tempDir: string;
  let store: ConversationStore;
  let history: ConversationHistory;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-test-'));
    store = new ConversationStore({ baseDir: tempDir });
    history = new ConversationHistory(store);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getHistory', () => {
    // AC: @msg-history ac-1 - returns messages in chronological order with timestamps
    it('returns empty array for non-existent session', async () => {
      const entries = await history.getHistory('unknown:session');
      expect(entries).toEqual([]);
    });

    // AC: @msg-history ac-1 - returns messages in chronological order with timestamps
    it('returns turns in chronological order', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      // Append turns with explicit timestamps
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello',
        ts: 1000,
        seq: 0,
      });
      await store.appendTurn(conversation.id, {
        role: 'assistant',
        content: 'Hi there!',
        ts: 2000,
        seq: 1,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'How are you?',
        ts: 3000,
        seq: 2,
      });

      const entries = await history.getHistory(sessionKey);

      expect(entries).toHaveLength(3);
      expect(entries[0].turn.content).toBe('Hello');
      expect(entries[0].turn.ts).toBe(1000);
      expect(entries[1].turn.content).toBe('Hi there!');
      expect(entries[1].turn.ts).toBe(2000);
      expect(entries[2].turn.content).toBe('How are you?');
      expect(entries[2].turn.ts).toBe(3000);
    });

    // AC: @msg-history ac-1 - returns messages in chronological order with timestamps
    it('includes timestamps in each entry', async () => {
      const sessionKey = 'discord:dm:user123';

      await history.addTurn(sessionKey, {
        role: 'user',
        content: 'Test message',
      });

      const entries = await history.getHistory(sessionKey);

      expect(entries).toHaveLength(1);
      expect(entries[0].turn.ts).toBeDefined();
      expect(typeof entries[0].turn.ts).toBe('number');
      expect(entries[0].turn.ts).toBeGreaterThan(0);
    });
  });

  describe('addTurn', () => {
    it('creates conversation if not exists', async () => {
      const sessionKey = 'discord:dm:newuser';

      const entry = await history.addTurn(sessionKey, {
        role: 'user',
        content: 'Hello!',
      });

      expect(entry.turn.role).toBe('user');
      expect(entry.turn.content).toBe('Hello!');

      const entries = await history.getHistory(sessionKey);
      expect(entries).toHaveLength(1);
    });

    it('appends to existing conversation', async () => {
      const sessionKey = 'discord:dm:user123';

      await history.addTurn(sessionKey, {
        role: 'user',
        content: 'Hello',
      });
      await history.addTurn(sessionKey, {
        role: 'assistant',
        content: 'Hi!',
      });

      const entries = await history.getHistory(sessionKey);
      expect(entries).toHaveLength(2);
    });

    it('detects boundary when adding turn', async () => {
      const sessionKey = 'discord:dm:user123';

      // First turn - no boundary
      const first = await history.addTurn(sessionKey, {
        role: 'user',
        content: 'Hello',
      });
      expect(first.semanticBoundary).toBe(false);

      // Second turn with topic change pattern - should be boundary
      const second = await history.addTurn(sessionKey, {
        role: 'user',
        content: "Let's talk about something else",
      });
      expect(second.semanticBoundary).toBe(true);
    });

    it('accepts message_id for idempotency', async () => {
      const sessionKey = 'discord:dm:user123';

      await history.addTurn(sessionKey, {
        role: 'user',
        content: 'Hello!',
        message_id: 'msg-123',
      });

      // Duplicate should be idempotent
      await history.addTurn(sessionKey, {
        role: 'user',
        content: 'Different content',
        message_id: 'msg-123',
      });

      const entries = await history.getHistory(sessionKey);
      expect(entries).toHaveLength(1);
      expect(entries[0].turn.content).toBe('Hello!');
    });
  });

  describe('semantic boundary detection', () => {
    // AC: @msg-history ac-2 - detects topic changes and marks semantic boundary
    it('detects long pauses as boundaries', async () => {
      const pauseThreshold = 1000; // 1 second for testing
      const shortPauseHistory = new ConversationHistory(store, {
        pauseThreshold,
      });

      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'First message',
        ts: 1000,
        seq: 0,
      });

      // Short pause - no boundary
      await store.appendTurn(conversation.id, {
        role: 'assistant',
        content: 'Quick reply',
        ts: 1500,
        seq: 1,
      });

      // Long pause - should be boundary
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Much later',
        ts: 3000,
        seq: 2,
      });

      const entries = await shortPauseHistory.getHistory(sessionKey);

      expect(entries[0].semanticBoundary).toBe(false);
      expect(entries[1].semanticBoundary).toBe(false);
      expect(entries[2].semanticBoundary).toBe(true);
    });

    // AC: @msg-history ac-2 - detects topic changes
    it('detects explicit topic change patterns', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'How is the weather?',
        ts: 1000,
        seq: 0,
      });

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: "Let's talk about something else",
        ts: 1100,
        seq: 1,
      });

      const entries = await history.getHistory(sessionKey);

      expect(entries[0].semanticBoundary).toBe(false);
      expect(entries[1].semanticBoundary).toBe(true);
    });

    // AC: @msg-history ac-2 - marks boundary in history for context windowing
    it('detects multiple topic change patterns', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      const patterns = [
        { content: 'Initial topic', expectBoundary: false },
        { content: 'By the way, have you seen that movie?', expectBoundary: true },
        { content: 'It was good', expectBoundary: false },
        { content: 'Can we discuss the project?', expectBoundary: true },
        { content: 'Sure thing', expectBoundary: false },
        { content: 'On another note, did you eat?', expectBoundary: true },
      ];

      for (let i = 0; i < patterns.length; i++) {
        await store.appendTurn(conversation.id, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: patterns[i].content,
          ts: 1000 + i * 100,
          seq: i,
        });
      }

      const entries = await history.getHistory(sessionKey);

      for (let i = 0; i < patterns.length; i++) {
        expect(entries[i].semanticBoundary).toBe(patterns[i].expectBoundary);
      }
    });

    it('detects question-answer pattern breaks', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      // User asks question
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'What is the weather?',
        ts: 1000,
        seq: 0,
      });

      // User asks another question (same role, both questions = boundary)
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'What about tomorrow?',
        ts: 1100,
        seq: 1,
      });

      const entries = await history.getHistory(sessionKey);

      expect(entries[0].semanticBoundary).toBe(false);
      expect(entries[1].semanticBoundary).toBe(true);
    });

    it('supports custom boundary patterns', async () => {
      const customHistory = new ConversationHistory(store, {
        boundaryPatterns: [/\bNEW TOPIC\b/i],
      });

      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Regular message',
        ts: 1000,
        seq: 0,
      });

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'NEW TOPIC: something else',
        ts: 1100,
        seq: 1,
      });

      const entries = await customHistory.getHistory(sessionKey);

      expect(entries[0].semanticBoundary).toBe(false);
      expect(entries[1].semanticBoundary).toBe(true);
    });
  });

  describe('markBoundary', () => {
    // AC: @msg-history ac-2 - marks boundary in history for context windowing
    it('marks boundary at specific turn', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Message 1',
        ts: 1000,
        seq: 0,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Message 2',
        ts: 1100,
        seq: 1,
      });

      const result = await history.markBoundary(sessionKey, 1);
      expect(result).toBe(true);

      const entries = await history.getHistory(sessionKey);

      // Turn at seq 1 should now be marked as boundary
      expect(entries[1].semanticBoundary).toBe(true);
    });

    it('returns false for non-existent session', async () => {
      const result = await history.markBoundary('unknown:session', 0);
      expect(result).toBe(false);
    });

    it('returns false for non-existent turn', async () => {
      const sessionKey = 'discord:dm:user123';
      await store.createConversation(sessionKey);

      const result = await history.markBoundary(sessionKey, 999);
      expect(result).toBe(false);
    });

    it('allows topic label when marking boundary', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Message 1',
        ts: 1000,
        seq: 0,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Message 2',
        ts: 1100,
        seq: 1,
      });

      await history.markBoundary(sessionKey, 1, 'New Discussion');

      // The boundary is persisted via a system message - verify it exists
      const turns = await store.readTurns(conversation.id);
      const boundaryMarker = turns.find(
        (t) => t.role === 'system' && t.metadata?.type === 'boundary_marker',
      );
      expect(boundaryMarker).toBeDefined();
      expect(boundaryMarker?.metadata?.topic).toBe('New Discussion');
    });
  });

  describe('cleanup', () => {
    // AC: @msg-history ac-3 - archives history and releases active resources
    it('archives timed out session', async () => {
      const shortTimeout = 100; // 100ms for testing
      const shortTimeoutHistory = new ConversationHistory(store, {
        sessionTimeout: shortTimeout,
      });

      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello',
        ts: Date.now() - shortTimeout - 1, // Ensure it's past timeout
      });

      const result = await shortTimeoutHistory.cleanup(sessionKey);

      expect(result.archived).toBe(true);
      expect(result.reason).toBe('timeout');
      expect(result.conversation?.status).toBe('archived');
    });

    // AC: @msg-history ac-3 - cleanup triggered on session timeout
    it('does not archive active session without force', async () => {
      const sessionKey = 'discord:dm:user123';

      await history.addTurn(sessionKey, {
        role: 'user',
        content: 'Hello',
      });

      const result = await history.cleanup(sessionKey);

      expect(result.archived).toBe(false);
    });

    // AC: @msg-history ac-3 - archives history and releases active resources
    it('archives with force regardless of timeout', async () => {
      const sessionKey = 'discord:dm:user123';

      await history.addTurn(sessionKey, {
        role: 'user',
        content: 'Hello',
      });

      const result = await history.forceCleanup(sessionKey);

      expect(result.archived).toBe(true);
      expect(result.reason).toBe('manual');
    });

    it('returns already_archived for archived sessions', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);
      await store.archiveConversation(conversation.id);

      const result = await history.cleanup(sessionKey);

      expect(result.archived).toBe(false);
      expect(result.reason).toBe('already_archived');
    });

    it('handles non-existent session gracefully', async () => {
      const result = await history.cleanup('unknown:session');

      expect(result.archived).toBe(false);
    });
  });

  describe('isTimedOut', () => {
    it('returns false for non-existent session', async () => {
      const timedOut = await history.isTimedOut('unknown:session');
      expect(timedOut).toBe(false);
    });

    it('returns true when last turn exceeds timeout', async () => {
      const shortTimeout = 100;
      const shortTimeoutHistory = new ConversationHistory(store, {
        sessionTimeout: shortTimeout,
      });

      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Old message',
        ts: Date.now() - shortTimeout - 50,
      });

      const timedOut = await shortTimeoutHistory.isTimedOut(sessionKey);
      expect(timedOut).toBe(true);
    });

    it('returns false when last turn is within timeout', async () => {
      const sessionKey = 'discord:dm:user123';

      await history.addTurn(sessionKey, {
        role: 'user',
        content: 'Recent message',
      });

      const timedOut = await history.isTimedOut(sessionKey);
      expect(timedOut).toBe(false);
    });

    it('checks creation time for empty conversations', async () => {
      const shortTimeout = 100;
      const shortTimeoutHistory = new ConversationHistory(store, {
        sessionTimeout: shortTimeout,
      });

      const sessionKey = 'discord:dm:user123';
      await store.createConversation(sessionKey);

      // Wait for timeout
      await new Promise((r) => setTimeout(r, shortTimeout + 50));

      const timedOut = await shortTimeoutHistory.isTimedOut(sessionKey);
      expect(timedOut).toBe(true);
    });
  });

  describe('getSegments', () => {
    it('returns empty array for non-existent session', async () => {
      const segments = await history.getSegments('unknown:session');
      expect(segments).toEqual([]);
    });

    it('returns single segment when no boundaries', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello',
        ts: 1000,
        seq: 0,
      });
      await store.appendTurn(conversation.id, {
        role: 'assistant',
        content: 'Hi!',
        ts: 1100,
        seq: 1,
      });

      const segments = await history.getSegments(sessionKey);

      expect(segments).toHaveLength(1);
      expect(segments[0]).toHaveLength(2);
    });

    it('splits on semantic boundaries', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello',
        ts: 1000,
        seq: 0,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: "Let's talk about something else",
        ts: 1100,
        seq: 1,
      });
      await store.appendTurn(conversation.id, {
        role: 'assistant',
        content: 'Sure, what?',
        ts: 1200,
        seq: 2,
      });

      const segments = await history.getSegments(sessionKey);

      expect(segments).toHaveLength(2);
      expect(segments[0]).toHaveLength(1); // First segment: Hello
      expect(segments[1]).toHaveLength(2); // Second segment: topic change + response
    });
  });

  describe('getCurrentSegment', () => {
    it('returns empty array for non-existent session', async () => {
      const segment = await history.getCurrentSegment('unknown:session');
      expect(segment).toEqual([]);
    });

    it('returns most recent segment', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Old topic',
        ts: 1000,
        seq: 0,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: "Let's talk about code",
        ts: 1100,
        seq: 1,
      });
      await store.appendTurn(conversation.id, {
        role: 'assistant',
        content: 'Sure, what code?',
        ts: 1200,
        seq: 2,
      });

      const segment = await history.getCurrentSegment(sessionKey);

      expect(segment).toHaveLength(2);
      expect(segment[0].turn.content).toBe("Let's talk about code");
      expect(segment[1].turn.content).toBe('Sure, what code?');
    });
  });

  describe('getHistoryById', () => {
    it('returns history by conversation ID', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello',
      });

      const entries = await history.getHistoryById(conversation.id);

      expect(entries).toHaveLength(1);
      expect(entries[0].turn.content).toBe('Hello');
    });
  });

  describe('topic extraction', () => {
    it('extracts topic from "let\'s talk about" pattern', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Hello',
        ts: 1000,
        seq: 0,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: "Let's talk about the weather",
        ts: 1100,
        seq: 1,
      });

      const entries = await history.getHistory(sessionKey);

      expect(entries[1].topic).toBe('the weather');
    });
  });

  describe('configuration', () => {
    it('uses default session timeout of 30 minutes', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      // Add a turn 29 minutes ago - should not be timed out
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Recent',
        ts: Date.now() - 29 * 60 * 1000,
      });

      const timedOut = await history.isTimedOut(sessionKey);
      expect(timedOut).toBe(false);
    });

    it('uses default pause threshold of 5 minutes', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'First',
        ts: 1000,
        seq: 0,
      });

      // 4 minute gap - should not be boundary
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Second',
        ts: 1000 + 4 * 60 * 1000,
        seq: 1,
      });

      const entries = await history.getHistory(sessionKey);
      expect(entries[1].semanticBoundary).toBe(false);
    });

    it('allows custom configuration', async () => {
      const options: HistoryOptions = {
        sessionTimeout: 60000,
        pauseThreshold: 30000,
        boundaryPatterns: [/CUSTOM_MARKER/],
      };

      const customHistory = new ConversationHistory(store, options);
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'Regular',
        ts: 1000,
        seq: 0,
      });
      await store.appendTurn(conversation.id, {
        role: 'user',
        content: 'CUSTOM_MARKER here',
        ts: 1100,
        seq: 1,
      });

      const entries = await customHistory.getHistory(sessionKey);
      expect(entries[1].semanticBoundary).toBe(true);
    });
  });
});
