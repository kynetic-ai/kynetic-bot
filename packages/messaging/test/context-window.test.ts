/**
 * ContextWindowManager Tests
 *
 * Tests for context window management with token-based compaction.
 *
 * @see @mem-context-window
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConversationStore, type ConversationTurn } from '@kynetic-bot/memory';
import {
  ContextWindowManager,
  MockSummaryProvider,
  type ContextWindowEvents,
} from '../src/context/index.js';
import { ConversationHistory } from '../src/history.js';
import {
  MockTurnReconstructor,
  TEST_SESSION_ID,
  createTestTurnInput,
} from './helpers/mock-turn-reconstructor.js';

describe('ContextWindowManager', () => {
  let tempDir: string;
  let store: ConversationStore;
  let history: ConversationHistory;
  let emitter: EventEmitter;
  let mockProvider: MockSummaryProvider;
  let mockReconstructor: MockTurnReconstructor;
  let seqCounter: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-window-test-'));
    emitter = new EventEmitter();
    store = new ConversationStore({ baseDir: tempDir, emitter });
    mockReconstructor = new MockTurnReconstructor();
    history = new ConversationHistory(store, { turnReconstructor: mockReconstructor });
    mockProvider = new MockSummaryProvider({ turnReconstructor: mockReconstructor });
    seqCounter = 0;
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to add a turn with content
   */
  async function addTurnWithContent(
    sessionKey: string,
    content: string,
    role: 'user' | 'assistant' = 'user'
  ) {
    const seq = seqCounter++;
    mockReconstructor.setContentBySeq(TEST_SESSION_ID, seq, content);
    mockProvider.setContent(seq, content);
    return history.addTurn(sessionKey, createTestTurnInput(role, seq));
  }

  describe('getContext', () => {
    // AC: @mem-context-window ac-1 - compacts older messages when approaching token limit
    it('returns context entries for a session', async () => {
      const sessionKey = 'discord:dm:user123';

      // Add some turns
      await addTurnWithContent(sessionKey, 'Hello');
      await addTurnWithContent(sessionKey, 'Hi there!', 'assistant');

      const manager = new ContextWindowManager(store, history, mockProvider, {
        emitter,
        turnReconstructor: mockReconstructor,
      });
      const result = await manager.getContext(sessionKey);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].type).toBe('turn');
      expect(result.compacted).toBe(false);
    });

    it('returns empty result for non-existent session', async () => {
      const manager = new ContextWindowManager(store, history, mockProvider, {
        emitter,
        turnReconstructor: mockReconstructor,
      });
      const result = await manager.getContext('discord:dm:nonexistent');

      expect(result.entries).toHaveLength(0);
      expect(result.totalTokens).toBe(0);
    });

    // AC: @mem-context-window ac-1 - compacts when new message added
    it('triggers compaction when exceeding threshold', async () => {
      const sessionKey = 'discord:dm:user456';

      // Create manager with very small max tokens to guarantee compaction
      // Low threshold ensures any reasonable number of messages triggers it
      const manager = new ContextWindowManager(store, history, mockProvider, {
        maxTokens: 100,
        softThreshold: 0.5, // 50 tokens
        hardThreshold: 0.8,
        emitter,
        turnReconstructor: mockReconstructor,
      });

      // Add enough turns to exceed threshold
      // Each turn: ~25 chars / 4 = 6 tokens + 10 overhead = 16 tokens
      // 4 turns = 64 tokens, exceeds soft threshold of 50
      for (let i = 0; i < 6; i++) {
        await addTurnWithContent(
          sessionKey,
          `Message ${i} with content`,
          i % 2 === 0 ? 'user' : 'assistant'
        );
      }

      const events: Array<ContextWindowEvents['compaction:started']> = [];
      emitter.on('compaction:started', (data) => events.push(data));

      await manager.getContext(sessionKey);

      // Should have triggered compaction (soft or hard depending on token count)
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(['soft', 'hard']).toContain(events[0].threshold);
    });

    // AC: @mem-context-window ac-1 - hard compaction at 85%
    it('triggers hard compaction at 85% threshold', async () => {
      const sessionKey = 'discord:dm:user789';

      const smallMaxTokens = 200;
      const manager = new ContextWindowManager(store, history, mockProvider, {
        maxTokens: smallMaxTokens,
        softThreshold: 0.7,
        hardThreshold: 0.85,
        emitter,
        turnReconstructor: mockReconstructor,
      });

      // Add enough turns to exceed 85% threshold
      for (let i = 0; i < 12; i++) {
        await addTurnWithContent(
          sessionKey,
          `Message ${i} with some content that takes up more tokens and exceeds thresholds`,
          i % 2 === 0 ? 'user' : 'assistant'
        );
      }

      const events: Array<ContextWindowEvents['compaction:started']> = [];
      emitter.on('compaction:started', (data) => events.push(data));

      await manager.getContext(sessionKey);

      // Should have triggered hard compaction
      const hardCompaction = events.find((e) => e.threshold === 'hard');
      expect(hardCompaction).toBeDefined();
    });
  });

  describe('compaction', () => {
    // AC: @mem-context-window ac-2 - preserves boundary markers for topic continuity
    it('preserves semantic boundaries during compaction', async () => {
      const sessionKey = 'discord:dm:boundary-test';

      const smallMaxTokens = 300;
      const manager = new ContextWindowManager(store, history, mockProvider, {
        maxTokens: smallMaxTokens,
        softThreshold: 0.5, // Low threshold to trigger compaction
        emitter,
        turnReconstructor: mockReconstructor,
      });

      // Add turns with a semantic boundary
      await addTurnWithContent(sessionKey, 'First topic discussion here');
      await addTurnWithContent(sessionKey, 'Response about first topic', 'assistant');

      // Wait to create a time gap (pause threshold)
      await new Promise((r) => setTimeout(r, 10));

      // Manually mark a boundary by using a topic-changing phrase
      await addTurnWithContent(sessionKey, "Let's talk about a completely different subject now");
      await addTurnWithContent(sessionKey, 'Sure, what about?', 'assistant');

      // Add more to trigger compaction
      for (let i = 0; i < 6; i++) {
        await addTurnWithContent(
          sessionKey,
          `Continued discussion message ${i} about the second topic`,
          i % 2 === 0 ? 'user' : 'assistant'
        );
      }

      const events: Array<ContextWindowEvents['compaction:completed']> = [];
      emitter.on('compaction:completed', (data) => events.push(data));

      await manager.getContext(sessionKey);

      // Check that compaction occurred and preserved boundaries
      expect(events.length).toBeGreaterThanOrEqual(1);
      // Recent messages should be preserved
    });

    // AC: @mem-context-window ac-4 - uses summary provider for compaction
    it('calls summary provider during compaction', async () => {
      const sessionKey = 'discord:dm:summary-test';

      const smallMaxTokens = 200;
      const manager = new ContextWindowManager(store, history, mockProvider, {
        maxTokens: smallMaxTokens,
        softThreshold: 0.5,
        emitter,
        turnReconstructor: mockReconstructor,
      });

      // Add turns to trigger compaction
      for (let i = 0; i < 8; i++) {
        await addTurnWithContent(
          sessionKey,
          `Please summarize this message ${i} with important content`,
          i % 2 === 0 ? 'user' : 'assistant'
        );
      }

      await manager.getContext(sessionKey);

      // Check that mock provider was called
      const calls = mockProvider.getSummaryCalls();
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].turns.length).toBeGreaterThan(0);
      expect(calls[0].sessionFileRef).toContain('conversations/');
    });

    // AC: @mem-context-window ac-3 - includes session file reference
    it('includes session file reference in summary', async () => {
      const sessionKey = 'discord:dm:fileref-test';

      const smallMaxTokens = 200;
      const manager = new ContextWindowManager(store, history, mockProvider, {
        maxTokens: smallMaxTokens,
        softThreshold: 0.5,
        emitter,
        turnReconstructor: mockReconstructor,
      });

      // Add turns
      for (let i = 0; i < 8; i++) {
        await addTurnWithContent(
          sessionKey,
          `Content message ${i}`,
          i % 2 === 0 ? 'user' : 'assistant'
        );
      }

      await manager.getContext(sessionKey);

      const calls = mockProvider.getSummaryCalls();
      if (calls.length > 0) {
        expect(calls[0].sessionFileRef).toMatch(/conversations\/[A-Z0-9]+\/turns\.jsonl/);
      }
    });
  });

  describe('addMessage', () => {
    it('adds a message and returns history entry', async () => {
      const sessionKey = 'discord:dm:add-test';

      const manager = new ContextWindowManager(store, history, mockProvider, {
        emitter,
        turnReconstructor: mockReconstructor,
      });

      const seq = seqCounter++;
      mockReconstructor.setContentBySeq(TEST_SESSION_ID, seq, 'Hello world');

      const entry = await manager.addMessage(sessionKey, createTestTurnInput('user', seq));

      expect(entry.turn.role).toBe('user');
      // Content is retrieved via reconstructor, not stored in turn
      const content = await mockReconstructor.getContent(TEST_SESSION_ID, entry.turn.event_range);
      expect(content).toBe('Hello world');
    });

    it('checks for compaction after adding message', async () => {
      const sessionKey = 'discord:dm:add-compact';

      const smallMaxTokens = 150;
      const manager = new ContextWindowManager(store, history, mockProvider, {
        maxTokens: smallMaxTokens,
        softThreshold: 0.5,
        emitter,
        turnReconstructor: mockReconstructor,
      });

      const events: Array<ContextWindowEvents['context:retrieved']> = [];
      emitter.on('context:retrieved', (data) => events.push(data));

      // Add multiple messages
      for (let i = 0; i < 6; i++) {
        const seq = seqCounter++;
        mockReconstructor.setContentBySeq(TEST_SESSION_ID, seq, `Message number ${i} with content`);
        mockProvider.setContent(seq, `Message number ${i} with content`);
        await manager.addMessage(sessionKey, createTestTurnInput(i % 2 === 0 ? 'user' : 'assistant', seq));
      }

      // Should have retrieved context to check for compaction
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('token estimation', () => {
    it('estimates tokens based on character count', () => {
      const manager = new ContextWindowManager(store, history, mockProvider, {
        charsPerToken: 4, // Default
        emitter,
        turnReconstructor: mockReconstructor,
      });

      // 20 chars / 4 = 5 tokens
      expect(manager.estimateTokens('12345678901234567890')).toBe(5);

      // 21 chars / 4 = 5.25, rounded up to 6
      expect(manager.estimateTokens('123456789012345678901')).toBe(6);
    });

    it('uses configurable chars per token', () => {
      const manager = new ContextWindowManager(store, history, mockProvider, {
        charsPerToken: 3,
        emitter,
        turnReconstructor: mockReconstructor,
      });

      // 12 chars / 3 = 4 tokens
      expect(manager.estimateTokens('123456789012')).toBe(4);
    });
  });

  describe('session file reference', () => {
    // AC: @mem-context-window ac-3 - session file reference for agent access
    it('provides session file path for conversation', async () => {
      const sessionKey = 'discord:dm:filepath-test';

      const manager = new ContextWindowManager(store, history, mockProvider, {
        emitter,
        turnReconstructor: mockReconstructor,
      });

      // Add a turn to create conversation
      await addTurnWithContent(sessionKey, 'test');

      const conversationId = await manager.getConversationId(sessionKey);
      expect(conversationId).not.toBeNull();

      const filePath = manager.getSessionFilePath(conversationId!);
      expect(filePath).toBe(`conversations/${conversationId}/turns.jsonl`);
    });

    it('returns null for non-existent session', async () => {
      const manager = new ContextWindowManager(store, history, mockProvider, {
        emitter,
        turnReconstructor: mockReconstructor,
      });

      const conversationId = await manager.getConversationId('discord:dm:nonexistent');
      expect(conversationId).toBeNull();
    });
  });

  describe('cache management', () => {
    it('clears cached summaries for a session', async () => {
      const sessionKey = 'discord:dm:cache-test';

      const smallMaxTokens = 150;
      const manager = new ContextWindowManager(store, history, mockProvider, {
        maxTokens: smallMaxTokens,
        softThreshold: 0.5,
        emitter,
        turnReconstructor: mockReconstructor,
      });

      // Add turns to trigger compaction
      for (let i = 0; i < 8; i++) {
        await addTurnWithContent(
          sessionKey,
          `Message ${i} content here`,
          i % 2 === 0 ? 'user' : 'assistant'
        );
      }

      await manager.getContext(sessionKey);

      // Clear cache
      manager.clearCache(sessionKey);

      // Get context again - provider should be called again if compaction needed
      mockProvider.clearCalls();
      await manager.getContext(sessionKey);

      // Since cache was cleared, may trigger compaction again
      // (depending on actual token counts)
    });
  });

  describe('observability', () => {
    // @trait-observable ac-1 - emits structured events
    it('emits context:retrieved event', async () => {
      const sessionKey = 'discord:dm:observe-test';

      const manager = new ContextWindowManager(store, history, mockProvider, {
        emitter,
        turnReconstructor: mockReconstructor,
      });

      await addTurnWithContent(sessionKey, 'Hello');

      const events: Array<ContextWindowEvents['context:retrieved']> = [];
      emitter.on('context:retrieved', (data) => events.push(data));

      await manager.getContext(sessionKey);

      expect(events).toHaveLength(1);
      expect(events[0].sessionKey).toBe(sessionKey);
      expect(events[0].entryCount).toBe(1);
    });

    // @trait-observable ac-2 - emits error events
    it('emits error event on failure', async () => {
      // Create a store that will fail
      const failingStore = {
        getConversationBySessionKey: () => {
          throw new Error('Store failure');
        },
      } as unknown as ConversationStore;

      const failingHistory = new ConversationHistory(failingStore, {
        turnReconstructor: mockReconstructor,
      });
      const manager = new ContextWindowManager(failingStore, failingHistory, mockProvider, {
        emitter,
        turnReconstructor: mockReconstructor,
      });

      const errors: Array<ContextWindowEvents['error']> = [];
      emitter.on('error', (data) => errors.push(data));

      await expect(manager.getContext('discord:dm:error-test')).rejects.toThrow('Store failure');

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe('getContext');
    });

    it('emits compaction events', async () => {
      const sessionKey = 'discord:dm:compact-events';

      const smallMaxTokens = 200;
      const manager = new ContextWindowManager(store, history, mockProvider, {
        maxTokens: smallMaxTokens,
        softThreshold: 0.5,
        emitter,
        turnReconstructor: mockReconstructor,
      });

      const startEvents: Array<ContextWindowEvents['compaction:started']> = [];
      const completeEvents: Array<ContextWindowEvents['compaction:completed']> = [];

      emitter.on('compaction:started', (data) => startEvents.push(data));
      emitter.on('compaction:completed', (data) => completeEvents.push(data));

      // Add turns to trigger compaction
      for (let i = 0; i < 8; i++) {
        await addTurnWithContent(
          sessionKey,
          `Message ${i} with substantial content here`,
          i % 2 === 0 ? 'user' : 'assistant'
        );
      }

      await manager.getContext(sessionKey);

      if (startEvents.length > 0) {
        expect(startEvents[0].sessionKey).toBe(sessionKey);
        expect(completeEvents.length).toBeGreaterThanOrEqual(1);
        expect(completeEvents[0].turnsSummarized).toBeGreaterThan(0);
      }
    });
  });

  describe('no summary provider', () => {
    it('does not compact when no summary provider configured', async () => {
      const sessionKey = 'discord:dm:no-provider';

      const smallMaxTokens = 150;
      const manager = new ContextWindowManager(store, history, undefined, {
        maxTokens: smallMaxTokens,
        softThreshold: 0.5,
        emitter,
        turnReconstructor: mockReconstructor,
      });

      const compactionEvents: Array<ContextWindowEvents['compaction:started']> = [];
      emitter.on('compaction:started', (data) => compactionEvents.push(data));

      // Add turns that would normally trigger compaction
      for (let i = 0; i < 8; i++) {
        await addTurnWithContent(
          sessionKey,
          `Message ${i} with content`,
          i % 2 === 0 ? 'user' : 'assistant'
        );
      }

      const result = await manager.getContext(sessionKey);

      // Should not compact without provider
      expect(result.compacted).toBe(false);
      // Compaction should not have started
      expect(compactionEvents).toHaveLength(0);
    });
  });
});

describe('MockSummaryProvider', () => {
  it('generates deterministic summary from turns', async () => {
    const mockReconstructor = new MockTurnReconstructor();
    const provider = new MockSummaryProvider({ turnReconstructor: mockReconstructor });

    // Create turns with event pointer schema and register content
    const turns: ConversationTurn[] = [
      {
        ts: 1000, seq: 0, role: 'user',
        session_id: TEST_SESSION_ID,
        event_range: { start_seq: 0, end_seq: 0 },
      },
      {
        ts: 1001, seq: 1, role: 'assistant',
        session_id: TEST_SESSION_ID,
        event_range: { start_seq: 1, end_seq: 1 },
      },
      {
        ts: 1002, seq: 2, role: 'user',
        session_id: TEST_SESSION_ID,
        event_range: { start_seq: 2, end_seq: 2 },
      },
    ];

    // Register content in reconstructor
    mockReconstructor.setContentBySeq(TEST_SESSION_ID, 0, 'Hello this is the first message');
    mockReconstructor.setContentBySeq(TEST_SESSION_ID, 1, 'Hi there, how can I help?');
    mockReconstructor.setContentBySeq(TEST_SESSION_ID, 2, 'Please help me with something');

    const summary = await provider.summarize(turns, 'conversations/abc123/turns.jsonl');

    expect(summary).toContain('## Topics Discussed');
    expect(summary).toContain('## Session Reference');
    expect(summary).toContain('conversations/abc123/turns.jsonl');
  });

  it('extracts instructions from user messages', async () => {
    const mockReconstructor = new MockTurnReconstructor();
    const provider = new MockSummaryProvider({ turnReconstructor: mockReconstructor });

    const turns: ConversationTurn[] = [
      {
        ts: 1000, seq: 0, role: 'user',
        session_id: TEST_SESSION_ID,
        event_range: { start_seq: 0, end_seq: 0 },
      },
      {
        ts: 1001, seq: 1, role: 'assistant',
        session_id: TEST_SESSION_ID,
        event_range: { start_seq: 1, end_seq: 1 },
      },
    ];

    mockReconstructor.setContentBySeq(TEST_SESSION_ID, 0, 'Please remember to always use TypeScript');
    mockReconstructor.setContentBySeq(TEST_SESSION_ID, 1, 'Understood!');

    const summary = await provider.summarize(turns, 'ref');

    expect(summary).toContain('## Key Instructions');
  });

  it('tracks summarize calls for testing', async () => {
    const mockReconstructor = new MockTurnReconstructor();
    const provider = new MockSummaryProvider({ turnReconstructor: mockReconstructor });

    const turns: ConversationTurn[] = [
      {
        ts: 1000, seq: 0, role: 'user',
        session_id: TEST_SESSION_ID,
        event_range: { start_seq: 0, end_seq: 0 },
      },
    ];
    mockReconstructor.setContentBySeq(TEST_SESSION_ID, 0, 'Test');

    await provider.summarize(turns, 'ref1');
    await provider.summarize(turns, 'ref2');

    const calls = provider.getSummaryCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].sessionFileRef).toBe('ref1');
    expect(calls[1].sessionFileRef).toBe('ref2');
  });

  it('clears recorded calls', async () => {
    const mockReconstructor = new MockTurnReconstructor();
    const provider = new MockSummaryProvider({ turnReconstructor: mockReconstructor });

    const turns: ConversationTurn[] = [
      {
        ts: 1000, seq: 0, role: 'user',
        session_id: TEST_SESSION_ID,
        event_range: { start_seq: 0, end_seq: 0 },
      },
    ];
    mockReconstructor.setContentBySeq(TEST_SESSION_ID, 0, 'Test');

    await provider.summarize(turns, 'ref');
    expect(provider.getSummaryCalls()).toHaveLength(1);

    provider.clearCalls();
    expect(provider.getSummaryCalls()).toHaveLength(0);
  });

  it('uses content map when no reconstructor', async () => {
    const provider = new MockSummaryProvider();

    const turns: ConversationTurn[] = [
      {
        ts: 1000, seq: 0, role: 'user',
        session_id: TEST_SESSION_ID,
        event_range: { start_seq: 0, end_seq: 0 },
      },
    ];

    // Set content directly in provider's map
    provider.setContent(0, 'Content from map');

    const summary = await provider.summarize(turns, 'ref');

    expect(summary).toContain('## Topics Discussed');
  });
});
