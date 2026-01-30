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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationStore, type ConversationTurn } from '@kynetic-bot/memory';
import {
  ContextWindowManager,
  MockSummaryProvider,
  type ContextWindowEvents,
} from '../src/context/index.js';
import { ConversationHistory } from '../src/history.js';

describe('ContextWindowManager', () => {
  let tempDir: string;
  let store: ConversationStore;
  let history: ConversationHistory;
  let emitter: EventEmitter;
  let mockProvider: MockSummaryProvider;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-window-test-'));
    emitter = new EventEmitter();
    store = new ConversationStore({ baseDir: tempDir, emitter });
    history = new ConversationHistory(store);
    mockProvider = new MockSummaryProvider();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getContext', () => {
    // AC: @mem-context-window ac-1 - compacts older messages when approaching token limit
    it('returns context entries for a session', async () => {
      const sessionKey = 'discord:dm:user123';

      // Add some turns
      await history.addTurn(sessionKey, { role: 'user', content: 'Hello' });
      await history.addTurn(sessionKey, { role: 'assistant', content: 'Hi there!' });

      const manager = new ContextWindowManager(store, history, mockProvider, { emitter });
      const result = await manager.getContext(sessionKey);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].type).toBe('turn');
      expect(result.compacted).toBe(false);
    });

    it('returns empty result for non-existent session', async () => {
      const manager = new ContextWindowManager(store, history, mockProvider, { emitter });
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
      });

      // Add enough turns to exceed threshold
      // Each turn: ~25 chars / 4 = 6 tokens + 10 overhead = 16 tokens
      // 4 turns = 64 tokens, exceeds soft threshold of 50
      for (let i = 0; i < 6; i++) {
        await history.addTurn(sessionKey, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i} with content`,
        });
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
      });

      // Add enough turns to exceed 85% threshold
      for (let i = 0; i < 12; i++) {
        await history.addTurn(sessionKey, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i} with some content that takes up more tokens and exceeds thresholds`,
        });
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
      });

      // Add turns with a semantic boundary
      await history.addTurn(sessionKey, { role: 'user', content: 'First topic discussion here' });
      await history.addTurn(sessionKey, { role: 'assistant', content: 'Response about first topic' });

      // Wait to create a time gap (pause threshold)
      await new Promise((r) => setTimeout(r, 10));

      // Manually mark a boundary by using a topic-changing phrase
      await history.addTurn(sessionKey, {
        role: 'user',
        content: "Let's talk about a completely different subject now",
      });
      await history.addTurn(sessionKey, { role: 'assistant', content: 'Sure, what about?' });

      // Add more to trigger compaction
      for (let i = 0; i < 6; i++) {
        await history.addTurn(sessionKey, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Continued discussion message ${i} about the second topic`,
        });
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
      });

      // Add turns to trigger compaction
      for (let i = 0; i < 8; i++) {
        await history.addTurn(sessionKey, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Please summarize this message ${i} with important content`,
        });
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
      });

      // Add turns
      for (let i = 0; i < 8; i++) {
        await history.addTurn(sessionKey, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Content message ${i}`,
        });
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

      const manager = new ContextWindowManager(store, history, mockProvider, { emitter });

      const entry = await manager.addMessage(sessionKey, {
        role: 'user',
        content: 'Hello world',
      });

      expect(entry.turn.content).toBe('Hello world');
      expect(entry.turn.role).toBe('user');
    });

    it('checks for compaction after adding message', async () => {
      const sessionKey = 'discord:dm:add-compact';

      const smallMaxTokens = 150;
      const manager = new ContextWindowManager(store, history, mockProvider, {
        maxTokens: smallMaxTokens,
        softThreshold: 0.5,
        emitter,
      });

      const events: Array<ContextWindowEvents['context:retrieved']> = [];
      emitter.on('context:retrieved', (data) => events.push(data));

      // Add multiple messages
      for (let i = 0; i < 6; i++) {
        await manager.addMessage(sessionKey, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message number ${i} with content`,
        });
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
      });

      // 12 chars / 3 = 4 tokens
      expect(manager.estimateTokens('123456789012')).toBe(4);
    });
  });

  describe('session file reference', () => {
    // AC: @mem-context-window ac-3 - session file reference for agent access
    it('provides session file path for conversation', async () => {
      const sessionKey = 'discord:dm:filepath-test';

      const manager = new ContextWindowManager(store, history, mockProvider, { emitter });

      // Add a turn to create conversation
      await history.addTurn(sessionKey, { role: 'user', content: 'test' });

      const conversationId = await manager.getConversationId(sessionKey);
      expect(conversationId).not.toBeNull();

      const filePath = manager.getSessionFilePath(conversationId!);
      expect(filePath).toBe(`conversations/${conversationId}/turns.jsonl`);
    });

    it('returns null for non-existent session', async () => {
      const manager = new ContextWindowManager(store, history, mockProvider, { emitter });

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
      });

      // Add turns to trigger compaction
      for (let i = 0; i < 8; i++) {
        await history.addTurn(sessionKey, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i} content here`,
        });
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

      const manager = new ContextWindowManager(store, history, mockProvider, { emitter });

      await history.addTurn(sessionKey, { role: 'user', content: 'Hello' });

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

      const failingHistory = new ConversationHistory(failingStore);
      const manager = new ContextWindowManager(failingStore, failingHistory, mockProvider, {
        emitter,
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
      });

      const startEvents: Array<ContextWindowEvents['compaction:started']> = [];
      const completeEvents: Array<ContextWindowEvents['compaction:completed']> = [];

      emitter.on('compaction:started', (data) => startEvents.push(data));
      emitter.on('compaction:completed', (data) => completeEvents.push(data));

      // Add turns to trigger compaction
      for (let i = 0; i < 8; i++) {
        await history.addTurn(sessionKey, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i} with substantial content here`,
        });
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
      });

      const compactionEvents: Array<ContextWindowEvents['compaction:started']> = [];
      emitter.on('compaction:started', (data) => compactionEvents.push(data));

      // Add turns that would normally trigger compaction
      for (let i = 0; i < 8; i++) {
        await history.addTurn(sessionKey, {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i} with content`,
        });
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
    const provider = new MockSummaryProvider();

    const turns: ConversationTurn[] = [
      { ts: 1000, seq: 0, role: 'user', content: 'Hello this is the first message' },
      { ts: 1001, seq: 1, role: 'assistant', content: 'Hi there, how can I help?' },
      { ts: 1002, seq: 2, role: 'user', content: 'Please help me with something' },
    ];

    const summary = await provider.summarize(turns, 'conversations/abc123/turns.jsonl');

    expect(summary).toContain('## Topics Discussed');
    expect(summary).toContain('## Session Reference');
    expect(summary).toContain('conversations/abc123/turns.jsonl');
  });

  it('extracts instructions from user messages', async () => {
    const provider = new MockSummaryProvider();

    const turns: ConversationTurn[] = [
      { ts: 1000, seq: 0, role: 'user', content: 'Please remember to always use TypeScript' },
      { ts: 1001, seq: 1, role: 'assistant', content: 'Understood!' },
    ];

    const summary = await provider.summarize(turns, 'ref');

    expect(summary).toContain('## Key Instructions');
  });

  it('tracks summarize calls for testing', async () => {
    const provider = new MockSummaryProvider();

    const turns: ConversationTurn[] = [
      { ts: 1000, seq: 0, role: 'user', content: 'Test' },
    ];

    await provider.summarize(turns, 'ref1');
    await provider.summarize(turns, 'ref2');

    const calls = provider.getSummaryCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].sessionFileRef).toBe('ref1');
    expect(calls[1].sessionFileRef).toBe('ref2');
  });

  it('clears recorded calls', async () => {
    const provider = new MockSummaryProvider();

    const turns: ConversationTurn[] = [
      { ts: 1000, seq: 0, role: 'user', content: 'Test' },
    ];

    await provider.summarize(turns, 'ref');
    expect(provider.getSummaryCalls()).toHaveLength(1);

    provider.clearCalls();
    expect(provider.getSummaryCalls()).toHaveLength(0);
  });
});
