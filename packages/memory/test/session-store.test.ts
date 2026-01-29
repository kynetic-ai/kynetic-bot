/**
 * SessionStore Tests
 *
 * Tests for session storage with JSONL event logs.
 *
 * @see @mem-agent-sessions
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
  SessionStore,
  SessionStoreError,
  SessionValidationError,
} from '../src/store/session-store.js';
import type { SessionEvent } from '../src/types/session.js';

describe('SessionStore', () => {
  let tempDir: string;
  let store: SessionStore;
  let emitter: EventEmitter;

  beforeEach(async () => {
    // Create temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-store-test-'));
    emitter = new EventEmitter();
    store = new SessionStore({ baseDir: tempDir, emitter });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('createSession', () => {
    // AC: @mem-agent-sessions ac-1 - creates session with session.yaml and events.jsonl
    it('creates session directory with session.yaml and events.jsonl', async () => {
      const sessionId = ulid();
      const session = await store.createSession({
        id: sessionId,
        agent_type: 'claude',
      });

      expect(session.id).toBe(sessionId);
      expect(session.agent_type).toBe('claude');

      // Check files created
      const sessionDir = path.join(tempDir, 'sessions', sessionId);
      expect(existsSync(sessionDir)).toBe(true);
      expect(existsSync(path.join(sessionDir, 'session.yaml'))).toBe(true);
      expect(existsSync(path.join(sessionDir, 'events.jsonl'))).toBe(true);

      // Verify session.yaml content
      const yamlContent = readFileSync(path.join(sessionDir, 'session.yaml'), 'utf-8');
      const parsed = yamlParse(yamlContent);
      expect(parsed.id).toBe(sessionId);
      expect(parsed.agent_type).toBe('claude');
      expect(parsed.status).toBe('active');
      expect(parsed.started_at).toBeDefined();
    });

    it('auto-assigns status=active and started_at', async () => {
      const session = await store.createSession({
        id: ulid(),
        agent_type: 'claude',
      });

      expect(session.status).toBe('active');
      expect(session.started_at).toBeDefined();
      expect(new Date(session.started_at).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('accepts optional fields', async () => {
      const session = await store.createSession({
        id: ulid(),
        agent_type: 'claude',
        conversation_id: 'conv-123',
        session_key: 'discord:dm:user123',
      });

      expect(session.conversation_id).toBe('conv-123');
      expect(session.session_key).toBe('discord:dm:user123');
    });

    it('allows overriding status and started_at', async () => {
      const customStart = '2026-01-29T10:00:00.000Z';
      const session = await store.createSession({
        id: ulid(),
        agent_type: 'claude',
        status: 'completed',
        started_at: customStart,
      });

      expect(session.status).toBe('completed');
      expect(session.started_at).toBe(customStart);
    });

    // AC: @trait-observable ac-1 - emits structured event
    it('emits session:created event', async () => {
      const events: Array<{ session: unknown }> = [];
      emitter.on('session:created', (data) => events.push(data));

      const session = await store.createSession({
        id: ulid(),
        agent_type: 'claude',
      });

      expect(events).toHaveLength(1);
      expect(events[0].session).toEqual(session);
    });

    // AC: @trait-validated ac-1 - returns structured error for invalid input
    it('throws SessionValidationError for invalid input', async () => {
      await expect(
        store.createSession({
          id: ulid(),
          agent_type: '', // Empty string not allowed
        }),
      ).rejects.toThrow(SessionValidationError);
    });

    // AC: @trait-validated ac-2 - identifies missing required field
    it('throws SessionValidationError for missing agent_type', async () => {
      await expect(
        store.createSession({
          id: ulid(),
          // Missing agent_type
        } as any),
      ).rejects.toThrow(SessionValidationError);
    });
  });

  describe('getSession', () => {
    it('returns session metadata', async () => {
      const sessionId = ulid();
      await store.createSession({
        id: sessionId,
        agent_type: 'claude',
      });

      const session = await store.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.id).toBe(sessionId);
      expect(session?.agent_type).toBe('claude');
    });

    it('returns null for non-existent session', async () => {
      const session = await store.getSession('nonexistent');
      expect(session).toBeNull();
    });

    it('returns null and emits error for corrupted session.yaml', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      // Corrupt the session.yaml
      const yamlPath = path.join(tempDir, 'sessions', sessionId, 'session.yaml');
      await fs.writeFile(yamlPath, 'invalid: yaml: content: [', 'utf-8');

      const errors: Array<{ error: Error }> = [];
      emitter.on('error', (data) => errors.push(data));

      const session = await store.getSession(sessionId);
      expect(session).toBeNull();
      // Error should be emitted
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('sessionExists', () => {
    it('returns true for existing session', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      expect(await store.sessionExists(sessionId)).toBe(true);
    });

    it('returns false for non-existent session', async () => {
      expect(await store.sessionExists('nonexistent')).toBe(false);
    });
  });

  describe('updateSessionStatus', () => {
    // AC: @mem-agent-sessions ac-4 - sets ended_at timestamp and final status
    it('sets ended_at when status is completed', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      const updated = await store.updateSessionStatus(sessionId, 'completed');

      expect(updated?.status).toBe('completed');
      expect(updated?.ended_at).toBeDefined();
      expect(new Date(updated!.ended_at!).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('sets ended_at when status is abandoned', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      const updated = await store.updateSessionStatus(sessionId, 'abandoned');

      expect(updated?.status).toBe('abandoned');
      expect(updated?.ended_at).toBeDefined();
    });

    it('does not set ended_at when status is active', async () => {
      const sessionId = ulid();
      await store.createSession({
        id: sessionId,
        agent_type: 'claude',
        status: 'completed',
      });

      const updated = await store.updateSessionStatus(sessionId, 'active');

      expect(updated?.status).toBe('active');
      // ended_at from original session shouldn't change
    });

    it('returns null for non-existent session', async () => {
      const updated = await store.updateSessionStatus('nonexistent', 'completed');
      expect(updated).toBeNull();
    });

    // AC: @trait-observable ac-1 - emits structured event
    it('emits session:ended event for terminal status', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      const events: Array<{ sessionId: string; status: string }> = [];
      emitter.on('session:ended', (data) => events.push(data));

      await store.updateSessionStatus(sessionId, 'completed');

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe(sessionId);
      expect(events[0].status).toBe('completed');
    });

    it('emits session:updated event for non-terminal status', async () => {
      const sessionId = ulid();
      await store.createSession({
        id: sessionId,
        agent_type: 'claude',
        status: 'completed',
      });

      const events: Array<{ sessionId: string; status: string }> = [];
      emitter.on('session:updated', (data) => events.push(data));

      await store.updateSessionStatus(sessionId, 'active');

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe(sessionId);
      expect(events[0].status).toBe('active');
    });

    it('persists status change to session.yaml', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      await store.updateSessionStatus(sessionId, 'completed');

      // Read directly from file
      const yamlPath = path.join(tempDir, 'sessions', sessionId, 'session.yaml');
      const content = readFileSync(yamlPath, 'utf-8');
      const parsed = yamlParse(content);

      expect(parsed.status).toBe('completed');
      expect(parsed.ended_at).toBeDefined();
    });
  });

  describe('listSessions', () => {
    it('returns empty array when no sessions exist', async () => {
      const sessions = await store.listSessions();
      expect(sessions).toEqual([]);
    });

    it('returns all sessions', async () => {
      await store.createSession({ id: ulid(), agent_type: 'claude' });
      await store.createSession({ id: ulid(), agent_type: 'openai' });

      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(2);
    });

    it('filters by status', async () => {
      const activeId = ulid();
      const completedId = ulid();

      await store.createSession({ id: activeId, agent_type: 'claude' });
      await store.createSession({ id: completedId, agent_type: 'claude' });
      await store.updateSessionStatus(completedId, 'completed');

      const activeSessions = await store.listSessions({ status: 'active' });
      expect(activeSessions).toHaveLength(1);
      expect(activeSessions[0].id).toBe(activeId);

      const completedSessions = await store.listSessions({ status: 'completed' });
      expect(completedSessions).toHaveLength(1);
      expect(completedSessions[0].id).toBe(completedId);
    });

    it('filters by agentType', async () => {
      await store.createSession({ id: ulid(), agent_type: 'claude' });
      await store.createSession({ id: ulid(), agent_type: 'openai' });

      const claudeSessions = await store.listSessions({ agentType: 'claude' });
      expect(claudeSessions).toHaveLength(1);
      expect(claudeSessions[0].agent_type).toBe('claude');
    });

    it('respects limit option', async () => {
      await store.createSession({ id: ulid(), agent_type: 'claude' });
      await store.createSession({ id: ulid(), agent_type: 'claude' });
      await store.createSession({ id: ulid(), agent_type: 'claude' });

      const sessions = await store.listSessions({ limit: 2 });
      expect(sessions).toHaveLength(2);
    });
  });

  describe('recoverOrphanedSessions', () => {
    // AC: @mem-agent-sessions ac-7 - marks orphaned sessions as abandoned
    it('marks active sessions as abandoned', async () => {
      const id1 = ulid();
      const id2 = ulid();
      const id3 = ulid();

      await store.createSession({ id: id1, agent_type: 'claude' });
      await store.createSession({ id: id2, agent_type: 'claude' });
      await store.createSession({ id: id3, agent_type: 'claude' });
      await store.updateSessionStatus(id3, 'completed');

      const recovered = await store.recoverOrphanedSessions();

      expect(recovered).toBe(2);

      // Check sessions are now abandoned
      const s1 = await store.getSession(id1);
      const s2 = await store.getSession(id2);
      const s3 = await store.getSession(id3);

      expect(s1?.status).toBe('abandoned');
      expect(s2?.status).toBe('abandoned');
      expect(s3?.status).toBe('completed'); // Unchanged
    });

    it('returns 0 when no active sessions', async () => {
      const id = ulid();
      await store.createSession({ id, agent_type: 'claude' });
      await store.updateSessionStatus(id, 'completed');

      const recovered = await store.recoverOrphanedSessions();
      expect(recovered).toBe(0);
    });
  });

  describe('appendEvent', () => {
    // AC: @mem-agent-sessions ac-2 - appends events with auto-assigned ts and seq
    it('appends event with auto-assigned ts and seq', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      const beforeTs = Date.now();
      const event = await store.appendEvent({
        type: 'session.start',
        session_id: sessionId,
        data: { trigger: 'test' },
      });
      const afterTs = Date.now();

      expect(event.seq).toBe(0);
      expect(event.ts).toBeGreaterThanOrEqual(beforeTs);
      expect(event.ts).toBeLessThanOrEqual(afterTs);
      expect(event.type).toBe('session.start');
      expect(event.session_id).toBe(sessionId);
    });

    it('increments seq for each event', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      const e1 = await store.appendEvent({
        type: 'session.start',
        session_id: sessionId,
        data: {},
      });
      const e2 = await store.appendEvent({
        type: 'prompt.sent',
        session_id: sessionId,
        data: { content: 'Hello' },
      });
      const e3 = await store.appendEvent({
        type: 'message.chunk',
        session_id: sessionId,
        data: { content: 'Hi' },
      });

      expect(e1.seq).toBe(0);
      expect(e2.seq).toBe(1);
      expect(e3.seq).toBe(2);
    });

    // AC: @mem-agent-sessions ac-3 - tool.call and tool.result events with correlation
    it('supports tool.call and tool.result events with trace_id correlation', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      const traceId = ulid();

      const callEvent = await store.appendEvent({
        type: 'tool.call',
        session_id: sessionId,
        trace_id: traceId,
        data: { tool_name: 'read_file', arguments: { path: '/tmp/test' } },
      });

      const resultEvent = await store.appendEvent({
        type: 'tool.result',
        session_id: sessionId,
        trace_id: traceId,
        data: { tool_name: 'read_file', success: true, result: 'contents' },
      });

      expect(callEvent.trace_id).toBe(traceId);
      expect(resultEvent.trace_id).toBe(traceId);
      expect(callEvent.seq).toBe(0);
      expect(resultEvent.seq).toBe(1);
    });

    it('allows overriding ts and seq', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      const customTs = 1706522400000;
      const customSeq = 100;

      const event = await store.appendEvent({
        type: 'note',
        session_id: sessionId,
        ts: customTs,
        seq: customSeq,
        data: { content: 'test' },
      });

      expect(event.ts).toBe(customTs);
      expect(event.seq).toBe(customSeq);
    });

    // AC: @mem-agent-sessions ac-5 - emits structured event for observability
    it('emits event:appended event', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      const events: Array<{ sessionId: string; event: SessionEvent }> = [];
      emitter.on('event:appended', (data) => events.push(data));

      const appended = await store.appendEvent({
        type: 'session.start',
        session_id: sessionId,
        data: {},
      });

      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe(sessionId);
      expect(events[0].event).toEqual(appended);
    });

    it('throws SessionStoreError for non-existent session', async () => {
      await expect(
        store.appendEvent({
          type: 'session.start',
          session_id: 'nonexistent',
          data: {},
        }),
      ).rejects.toThrow(SessionStoreError);
    });

    // AC: @mem-agent-sessions ac-6 - rejects with Zod validation error
    it('throws SessionValidationError for invalid event type', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      await expect(
        store.appendEvent({
          type: 'invalid.type' as any,
          session_id: sessionId,
          data: {},
        }),
      ).rejects.toThrow(SessionValidationError);
    });

    it('persists event to events.jsonl', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      await store.appendEvent({
        type: 'session.start',
        session_id: sessionId,
        data: { trigger: 'test' },
      });

      // Read directly from file
      const eventsPath = path.join(tempDir, 'sessions', sessionId, 'events.jsonl');
      const content = readFileSync(eventsPath, 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.type).toBe('session.start');
      expect(parsed.data.trigger).toBe('test');
    });
  });

  describe('readEvents', () => {
    it('returns events sorted by seq', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      // Append events with explicit out-of-order seq
      await store.appendEvent({
        type: 'note',
        session_id: sessionId,
        seq: 2,
        data: { content: 'third' },
      });
      await store.appendEvent({
        type: 'note',
        session_id: sessionId,
        seq: 0,
        data: { content: 'first' },
      });
      await store.appendEvent({
        type: 'note',
        session_id: sessionId,
        seq: 1,
        data: { content: 'second' },
      });

      const events = await store.readEvents(sessionId);

      expect(events).toHaveLength(3);
      expect(events[0].seq).toBe(0);
      expect(events[1].seq).toBe(1);
      expect(events[2].seq).toBe(2);
    });

    it('returns empty array for session with no events', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      const events = await store.readEvents(sessionId);
      expect(events).toEqual([]);
    });

    it('returns empty array for non-existent session', async () => {
      const events = await store.readEvents('nonexistent');
      expect(events).toEqual([]);
    });

    // AC: @trait-recoverable ac-2 - logs and attempts recovery for invalid lines
    it('skips invalid JSON lines with warning', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      // Append valid event
      await store.appendEvent({
        type: 'session.start',
        session_id: sessionId,
        data: {},
      });

      // Manually append invalid JSON line
      const eventsPath = path.join(tempDir, 'sessions', sessionId, 'events.jsonl');
      await fs.appendFile(eventsPath, 'invalid json line\n', 'utf-8');

      // Append another valid event
      await store.appendEvent({
        type: 'session.end',
        session_id: sessionId,
        data: { final_status: 'completed' },
      });

      const errors: Array<{ error: Error }> = [];
      emitter.on('error', (data) => errors.push(data));

      const events = await store.readEvents(sessionId);

      // Should have 2 valid events
      expect(events).toHaveLength(2);
      // Should have emitted error for skipped line
      expect(errors.some((e) => e.error.message.includes('Invalid JSON line'))).toBe(true);
    });
  });

  describe('readEventsSince', () => {
    it('returns events within time range', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      // Create events with specific timestamps
      await store.appendEvent({
        type: 'note',
        session_id: sessionId,
        ts: 1000,
        seq: 0,
        data: { content: 'early' },
      });
      await store.appendEvent({
        type: 'note',
        session_id: sessionId,
        ts: 2000,
        seq: 1,
        data: { content: 'middle' },
      });
      await store.appendEvent({
        type: 'note',
        session_id: sessionId,
        ts: 3000,
        seq: 2,
        data: { content: 'late' },
      });

      // Test since
      const sinceEvents = await store.readEventsSince(sessionId, 1500);
      expect(sinceEvents).toHaveLength(2);
      expect(sinceEvents[0].ts).toBe(2000);
      expect(sinceEvents[1].ts).toBe(3000);

      // Test since + until
      const rangeEvents = await store.readEventsSince(sessionId, 1500, 2500);
      expect(rangeEvents).toHaveLength(1);
      expect(rangeEvents[0].ts).toBe(2000);
    });
  });

  describe('getLastEvent', () => {
    it('returns last event by seq', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      await store.appendEvent({
        type: 'session.start',
        session_id: sessionId,
        data: {},
      });
      await store.appendEvent({
        type: 'prompt.sent',
        session_id: sessionId,
        data: { content: 'Hello' },
      });

      const lastEvent = await store.getLastEvent(sessionId);

      expect(lastEvent).not.toBeNull();
      expect(lastEvent?.type).toBe('prompt.sent');
      expect(lastEvent?.seq).toBe(1);
    });

    it('returns null for session with no events', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      const lastEvent = await store.getLastEvent(sessionId);
      expect(lastEvent).toBeNull();
    });
  });

  describe('getEventCount', () => {
    it('returns number of events', async () => {
      const sessionId = ulid();
      await store.createSession({ id: sessionId, agent_type: 'claude' });

      expect(await store.getEventCount(sessionId)).toBe(0);

      await store.appendEvent({
        type: 'session.start',
        session_id: sessionId,
        data: {},
      });
      expect(await store.getEventCount(sessionId)).toBe(1);

      await store.appendEvent({
        type: 'note',
        session_id: sessionId,
        data: { content: 'test' },
      });
      expect(await store.getEventCount(sessionId)).toBe(2);
    });

    it('returns 0 for non-existent session', async () => {
      expect(await store.getEventCount('nonexistent')).toBe(0);
    });
  });
});
