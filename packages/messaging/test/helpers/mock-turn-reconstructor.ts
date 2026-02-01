/**
 * Mock TurnReconstructor for testing
 *
 * Provides a simple content map for testing purposes.
 */

import type {
  TurnReconstructor,
  EventRange,
  ReconstructionResult,
  ConversationTurn,
  ConversationTurnInput,
} from '@kynetic-bot/memory';

/**
 * Default session ID for test turns
 */
export const TEST_SESSION_ID = 'test-session';

/**
 * Create a test turn with the new event-pointer schema.
 *
 * @param seq - Sequence number
 * @param role - Turn role (default: 'user')
 * @param ts - Timestamp (default: calculated from seq)
 */
export function createTestTurn(
  seq: number,
  role: 'user' | 'assistant' | 'system' = 'user',
  ts?: number
): ConversationTurn {
  return {
    ts: ts ?? Date.now() - (100 - seq) * 1000,
    seq,
    role,
    session_id: TEST_SESSION_ID,
    event_range: { start_seq: seq, end_seq: seq },
  };
}

/**
 * Create a test turn input (for appendTurn/addTurn calls).
 *
 * @param role - Turn role
 * @param seq - Sequence number (used for event_range)
 * @param message_id - Optional message ID for idempotency
 */
export function createTestTurnInput(
  role: 'user' | 'assistant' | 'system',
  seq: number,
  message_id?: string
): ConversationTurnInput {
  return {
    role,
    session_id: TEST_SESSION_ID,
    event_range: { start_seq: seq, end_seq: seq },
    message_id,
  };
}

/**
 * Create a turn and register its content in a MockTurnReconstructor.
 */
export function createTurnWithContent(
  seq: number,
  content: string,
  mock: MockTurnReconstructor,
  role: 'user' | 'assistant' | 'system' = 'user',
  ts?: number
): ConversationTurn {
  const turn = createTestTurn(seq, role, ts);
  mock.setContent(TEST_SESSION_ID, turn.event_range, content);
  return turn;
}

/**
 * MockTurnReconstructor stores content by session_id and event_range key.
 * Content can be set directly for testing.
 */
export class MockTurnReconstructor implements Pick<
  TurnReconstructor,
  'getContent' | 'reconstructContent'
> {
  private contentMap: Map<string, string> = new Map();

  /**
   * Generate a key from session_id and event_range
   */
  private getKey(sessionId: string, eventRange: EventRange): string {
    return `${sessionId}:${eventRange.start_seq}-${eventRange.end_seq}`;
  }

  /**
   * Set content for a specific session and event range
   */
  setContent(sessionId: string, eventRange: EventRange, content: string): void {
    this.contentMap.set(this.getKey(sessionId, eventRange), content);
  }

  /**
   * Set content using a simple key format for convenience
   */
  setContentBySeq(sessionId: string, seq: number, content: string): void {
    this.contentMap.set(`${sessionId}:${seq}-${seq}`, content);
  }

  /**
   * Get content for a session and event range
   */
  async getContent(sessionId: string, eventRange: EventRange): Promise<string> {
    const key = this.getKey(sessionId, eventRange);
    return this.contentMap.get(key) ?? '';
  }

  /**
   * Reconstruct content with full result
   */
  async reconstructContent(
    sessionId: string,
    eventRange: EventRange
  ): Promise<ReconstructionResult> {
    const content = await this.getContent(sessionId, eventRange);
    return {
      content,
      hasGaps: false,
      eventsRead: eventRange.end_seq - eventRange.start_seq + 1,
      eventsMissing: 0,
    };
  }

  /**
   * Clear all stored content
   */
  clear(): void {
    this.contentMap.clear();
  }
}
