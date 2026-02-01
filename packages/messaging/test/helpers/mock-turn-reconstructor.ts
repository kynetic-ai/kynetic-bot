/**
 * Mock TurnReconstructor for testing
 *
 * Provides a simple content map for testing purposes.
 */

import type { TurnReconstructor, EventRange, ReconstructionResult } from '@kynetic-bot/memory';

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
