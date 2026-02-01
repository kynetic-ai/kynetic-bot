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
import {
  MockTurnReconstructor,
  TEST_SESSION_ID,
  createTestTurnInput,
  createTurnWithContent,
} from './helpers/mock-turn-reconstructor.js';

describe('ConversationHistory', () => {
  let tempDir: string;
  let store: ConversationStore;
  let history: ConversationHistory;
  let mockReconstructor: MockTurnReconstructor;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'history-test-'));
    store = new ConversationStore({ baseDir: tempDir });
    mockReconstructor = new MockTurnReconstructor();
    history = new ConversationHistory(store, { turnReconstructor: mockReconstructor });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to append a turn and register its content in the mock
   */
  async function appendTurnWithContent(
    conversationId: string,
    content: string,
    seq: number,
    role: 'user' | 'assistant' | 'system' = 'user',
    ts?: number,
    message_id?: string
  ) {
    mockReconstructor.setContentBySeq(TEST_SESSION_ID, seq, content);
    return store.appendTurn(conversationId, {
      role,
      session_id: TEST_SESSION_ID,
      event_range: { start_seq: seq, end_seq: seq },
      ts,
      seq,
      message_id,
    });
  }

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
      await appendTurnWithContent(conversation.id, 'Hello', 0, 'user', 1000);
      await appendTurnWithContent(conversation.id, 'Hi there!', 1, 'assistant', 2000);
      await appendTurnWithContent(conversation.id, 'How are you?', 2, 'user', 3000);

      const entries = await history.getHistory(sessionKey);

      expect(entries).toHaveLength(3);
      // Note: turns no longer have content field - content is retrieved via TurnReconstructor
      expect(entries[0].turn.ts).toBe(1000);
      expect(entries[1].turn.ts).toBe(2000);
      expect(entries[2].turn.ts).toBe(3000);
    });

    // AC: @msg-history ac-1 - returns messages in chronological order with timestamps
    it('includes timestamps in each entry', async () => {
      const sessionKey = 'discord:dm:user123';

      await history.addTurn(sessionKey, createTestTurnInput('user', 0));

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
      mockReconstructor.setContentBySeq(TEST_SESSION_ID, 0, 'Hello!');

      const entry = await history.addTurn(sessionKey, createTestTurnInput('user', 0));

      expect(entry.turn.role).toBe('user');

      const entries = await history.getHistory(sessionKey);
      expect(entries).toHaveLength(1);
    });

    it('appends to existing conversation', async () => {
      const sessionKey = 'discord:dm:user123';

      await history.addTurn(sessionKey, createTestTurnInput('user', 0));
      await history.addTurn(sessionKey, createTestTurnInput('assistant', 1));

      const entries = await history.getHistory(sessionKey);
      expect(entries).toHaveLength(2);
    });

    it('detects boundary when adding turn', async () => {
      const sessionKey = 'discord:dm:user123';

      // First turn - no boundary (no previous turn)
      mockReconstructor.setContentBySeq(TEST_SESSION_ID, 0, 'Hello');
      const first = await history.addTurn(sessionKey, createTestTurnInput('user', 0));
      expect(first.semanticBoundary).toBe(false);

      // Second turn with topic change pattern - should be detected as boundary
      mockReconstructor.setContentBySeq(TEST_SESSION_ID, 1, "Let's talk about something else");
      const second = await history.addTurn(sessionKey, createTestTurnInput('user', 1));
      // Topic change pattern "let's talk about" is detected
      expect(second.semanticBoundary).toBe(true);
    });

    it('accepts message_id for idempotency', async () => {
      const sessionKey = 'discord:dm:user123';
      mockReconstructor.setContentBySeq(TEST_SESSION_ID, 0, 'Hello!');

      await history.addTurn(sessionKey, createTestTurnInput('user', 0, 'msg-123'));

      // Duplicate should be idempotent
      await history.addTurn(sessionKey, createTestTurnInput('user', 0, 'msg-123'));

      const entries = await history.getHistory(sessionKey);
      expect(entries).toHaveLength(1);
    });
  });

  describe('semantic boundary detection', () => {
    // AC: @msg-history ac-2 - detects topic changes and marks semantic boundary
    it('detects long pauses as boundaries', async () => {
      const pauseThreshold = 1000; // 1 second for testing
      const shortPauseHistory = new ConversationHistory(store, {
        pauseThreshold,
        turnReconstructor: mockReconstructor,
      });

      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(conversation.id, 'First message', 0, 'user', 1000);
      // Short pause - no boundary
      await appendTurnWithContent(conversation.id, 'Quick reply', 1, 'assistant', 1500);
      // Long pause - should be boundary
      await appendTurnWithContent(conversation.id, 'Much later', 2, 'user', 3000);

      const entries = await shortPauseHistory.getHistory(sessionKey);

      expect(entries[0].semanticBoundary).toBe(false);
      expect(entries[1].semanticBoundary).toBe(false);
      expect(entries[2].semanticBoundary).toBe(true);
    });

    // AC: @msg-history ac-2 - detects topic changes
    it('detects explicit topic change patterns', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(conversation.id, 'How is the weather?', 0, 'user', 1000);
      await appendTurnWithContent(conversation.id, "Let's talk about something else", 1, 'user', 1100);

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
        await appendTurnWithContent(
          conversation.id,
          patterns[i].content,
          i,
          i % 2 === 0 ? 'user' : 'assistant',
          1000 + i * 100
        );
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
      await appendTurnWithContent(conversation.id, 'What is the weather?', 0, 'user', 1000);
      // User asks another question (same role, both questions = boundary)
      await appendTurnWithContent(conversation.id, 'What about tomorrow?', 1, 'user', 1100);

      const entries = await history.getHistory(sessionKey);

      expect(entries[0].semanticBoundary).toBe(false);
      expect(entries[1].semanticBoundary).toBe(true);
    });

    it('supports custom boundary patterns', async () => {
      const customHistory = new ConversationHistory(store, {
        boundaryPatterns: [/\bNEW TOPIC\b/i],
        turnReconstructor: mockReconstructor,
      });

      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(conversation.id, 'Regular message', 0, 'user', 1000);
      await appendTurnWithContent(conversation.id, 'NEW TOPIC: something else', 1, 'user', 1100);

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

      await appendTurnWithContent(conversation.id, 'Message 1', 0, 'user', 1000);
      await appendTurnWithContent(conversation.id, 'Message 2', 1, 'user', 1100);

      // markBoundary now needs session_id and event_range for the marker turn
      const result = await history.markBoundary(
        sessionKey,
        1,
        TEST_SESSION_ID,
        { start_seq: 2, end_seq: 2 }
      );
      expect(result).toBe(true);

      const entries = await history.getHistory(sessionKey);

      // Turn at seq 1 should now be marked as boundary
      expect(entries[1].semanticBoundary).toBe(true);
    });

    it('returns false for non-existent session', async () => {
      const result = await history.markBoundary(
        'unknown:session',
        0,
        TEST_SESSION_ID,
        { start_seq: 0, end_seq: 0 }
      );
      expect(result).toBe(false);
    });

    it('returns false for non-existent turn', async () => {
      const sessionKey = 'discord:dm:user123';
      await store.createConversation(sessionKey);

      const result = await history.markBoundary(
        sessionKey,
        999,
        TEST_SESSION_ID,
        { start_seq: 0, end_seq: 0 }
      );
      expect(result).toBe(false);
    });

    it('allows topic label when marking boundary', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(conversation.id, 'Message 1', 0, 'user', 1000);
      await appendTurnWithContent(conversation.id, 'Message 2', 1, 'user', 1100);

      await history.markBoundary(
        sessionKey,
        1,
        TEST_SESSION_ID,
        { start_seq: 2, end_seq: 2 },
        'New Discussion'
      );

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
        turnReconstructor: mockReconstructor,
      });

      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(
        conversation.id,
        'Hello',
        0,
        'user',
        Date.now() - shortTimeout - 1 // Ensure it's past timeout
      );

      const result = await shortTimeoutHistory.cleanup(sessionKey);

      expect(result.archived).toBe(true);
      expect(result.reason).toBe('timeout');
      expect(result.conversation?.status).toBe('archived');
    });

    // AC: @msg-history ac-3 - cleanup triggered on session timeout
    it('does not archive active session without force', async () => {
      const sessionKey = 'discord:dm:user123';
      mockReconstructor.setContentBySeq(TEST_SESSION_ID, 0, 'Hello');

      await history.addTurn(sessionKey, createTestTurnInput('user', 0));

      const result = await history.cleanup(sessionKey);

      expect(result.archived).toBe(false);
    });

    // AC: @msg-history ac-3 - archives history and releases active resources
    it('archives with force regardless of timeout', async () => {
      const sessionKey = 'discord:dm:user123';
      mockReconstructor.setContentBySeq(TEST_SESSION_ID, 0, 'Hello');

      await history.addTurn(sessionKey, createTestTurnInput('user', 0));

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
        turnReconstructor: mockReconstructor,
      });

      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(
        conversation.id,
        'Old message',
        0,
        'user',
        Date.now() - shortTimeout - 50
      );

      const timedOut = await shortTimeoutHistory.isTimedOut(sessionKey);
      expect(timedOut).toBe(true);
    });

    it('returns false when last turn is within timeout', async () => {
      const sessionKey = 'discord:dm:user123';
      mockReconstructor.setContentBySeq(TEST_SESSION_ID, 0, 'Recent message');

      await history.addTurn(sessionKey, createTestTurnInput('user', 0));

      const timedOut = await history.isTimedOut(sessionKey);
      expect(timedOut).toBe(false);
    });

    it('checks creation time for empty conversations', async () => {
      const shortTimeout = 100;
      const shortTimeoutHistory = new ConversationHistory(store, {
        sessionTimeout: shortTimeout,
        turnReconstructor: mockReconstructor,
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

      await appendTurnWithContent(conversation.id, 'Hello', 0, 'user', 1000);
      await appendTurnWithContent(conversation.id, 'Hi!', 1, 'assistant', 1100);

      const segments = await history.getSegments(sessionKey);

      expect(segments).toHaveLength(1);
      expect(segments[0]).toHaveLength(2);
    });

    it('splits on semantic boundaries', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(conversation.id, 'Hello', 0, 'user', 1000);
      await appendTurnWithContent(conversation.id, "Let's talk about something else", 1, 'user', 1100);
      await appendTurnWithContent(conversation.id, 'Sure, what?', 2, 'assistant', 1200);

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

      await appendTurnWithContent(conversation.id, 'Old topic', 0, 'user', 1000);
      await appendTurnWithContent(conversation.id, "Let's talk about code", 1, 'user', 1100);
      await appendTurnWithContent(conversation.id, 'Sure, what code?', 2, 'assistant', 1200);

      const segment = await history.getCurrentSegment(sessionKey);

      expect(segment).toHaveLength(2);
      // Note: we can verify content via the mock reconstructor
      const content0 = await mockReconstructor.getContent(TEST_SESSION_ID, segment[0].turn.event_range);
      const content1 = await mockReconstructor.getContent(TEST_SESSION_ID, segment[1].turn.event_range);
      expect(content0).toBe("Let's talk about code");
      expect(content1).toBe('Sure, what code?');
    });
  });

  describe('getHistoryById', () => {
    it('returns history by conversation ID', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(conversation.id, 'Hello', 0, 'user');

      const entries = await history.getHistoryById(conversation.id);

      expect(entries).toHaveLength(1);
      // Content is retrieved via TurnReconstructor, not stored in turn
      const content = await mockReconstructor.getContent(TEST_SESSION_ID, entries[0].turn.event_range);
      expect(content).toBe('Hello');
    });
  });

  describe('topic extraction', () => {
    it('extracts topic from "let\'s talk about" pattern', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(conversation.id, 'Hello', 0, 'user', 1000);
      await appendTurnWithContent(conversation.id, "Let's talk about the weather", 1, 'user', 1100);

      const entries = await history.getHistory(sessionKey);

      expect(entries[1].topic).toBe('the weather');
    });
  });

  describe('configuration', () => {
    it('uses default session timeout of 30 minutes', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      // Add a turn 29 minutes ago - should not be timed out
      await appendTurnWithContent(
        conversation.id,
        'Recent',
        0,
        'user',
        Date.now() - 29 * 60 * 1000
      );

      const timedOut = await history.isTimedOut(sessionKey);
      expect(timedOut).toBe(false);
    });

    it('uses default pause threshold of 5 minutes', async () => {
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(conversation.id, 'First', 0, 'user', 1000);
      // 4 minute gap - should not be boundary
      await appendTurnWithContent(conversation.id, 'Second', 1, 'user', 1000 + 4 * 60 * 1000);

      const entries = await history.getHistory(sessionKey);
      expect(entries[1].semanticBoundary).toBe(false);
    });

    it('allows custom configuration', async () => {
      const options: HistoryOptions = {
        sessionTimeout: 60000,
        pauseThreshold: 30000,
        boundaryPatterns: [/CUSTOM_MARKER/],
        turnReconstructor: mockReconstructor,
      };

      const customHistory = new ConversationHistory(store, options);
      const sessionKey = 'discord:dm:user123';
      const conversation = await store.createConversation(sessionKey);

      await appendTurnWithContent(conversation.id, 'Regular', 0, 'user', 1000);
      await appendTurnWithContent(conversation.id, 'CUSTOM_MARKER here', 1, 'user', 1100);

      const entries = await customHistory.getHistory(sessionKey);
      expect(entries[1].semanticBoundary).toBe(true);
    });
  });
});
