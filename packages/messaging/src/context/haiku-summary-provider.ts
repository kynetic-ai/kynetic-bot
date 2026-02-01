/**
 * HaikuSummaryProvider - Summary generation via Haiku ACP
 *
 * Provides summary generation for context window compaction using
 * Claude Haiku via the ACP prompt method.
 *
 * AC: @mem-context-window ac-4 - Uses Haiku via ACP for summaries
 *
 * @see @mem-context-window
 */

import type { ConversationTurn, TurnReconstructor } from '@kynetic-bot/memory';
import type { SummaryProvider } from './context-window.js';

/**
 * ACP Client interface (minimal for summary generation)
 *
 * This interface matches the prompt method signature from ACPClient.
 * The actual client is injected to allow for different implementations.
 */
export interface ACPPromptClient {
  /**
   * Send a prompt to the agent and get a response.
   * The client handles session creation internally.
   */
  prompt(params: {
    sessionId: string;
    prompt: Array<{ type: 'text'; text: string }>;
    promptSource?: 'user' | 'system';
  }): Promise<{ stopReason?: string }>;

  /**
   * Create a new session for summarization.
   */
  newSession(params: { cwd: string; mcpServers: unknown[] }): Promise<string>;

  /**
   * Event listener for collecting response chunks.
   */
  on(
    event: 'update',
    handler: (sessionId: string, update: { sessionUpdate?: string; content?: { type?: string; text?: string } }) => void,
  ): void;

  /**
   * Remove event listener.
   */
  off(
    event: 'update',
    handler: (sessionId: string, update: { sessionUpdate?: string; content?: { type?: string; text?: string } }) => void,
  ): void;
}

/**
 * Options for HaikuSummaryProvider
 */
export interface HaikuSummaryProviderOptions {
  /** Maximum tokens for summary (default: 500) */
  maxSummaryTokens?: number;
  /** TurnReconstructor for content retrieval (required for content access) */
  turnReconstructor?: TurnReconstructor;
}

const DEFAULT_MAX_SUMMARY_TOKENS = 500;

/**
 * System prompt for summary generation
 */
const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Your task is to create concise summaries of conversation history that capture:

1. **Topics Discussed**: Key subjects and themes from the conversation
2. **Key User Instructions**: Important requests, preferences, or notes from the user
3. **Session Reference**: Include the provided session file path for detailed context retrieval

Format your response as:

## Topics Discussed
- Topic 1
- Topic 2

## Key Instructions/Notes
- Instruction 1
- Instruction 2

## Session Reference
For full conversation details, see: [session file path]

Be concise. Focus on information that would help continue the conversation.`;

/**
 * HaikuSummaryProvider generates summaries using Claude Haiku via ACP.
 *
 * AC: @mem-context-window ac-4 - Uses Haiku via ACP to generate short summary
 *
 * @example
 * ```typescript
 * const provider = new HaikuSummaryProvider(acpClient);
 *
 * const summary = await provider.summarize(turns, 'conversations/abc123/turns.jsonl');
 * ```
 */
export class HaikuSummaryProvider implements SummaryProvider {
  private readonly client: ACPPromptClient;
  private readonly maxSummaryTokens: number;
  private readonly turnReconstructor?: TurnReconstructor;

  constructor(client: ACPPromptClient, options: HaikuSummaryProviderOptions = {}) {
    this.client = client;
    this.maxSummaryTokens = options.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;
    this.turnReconstructor = options.turnReconstructor;
  }

  /**
   * Get content for a turn.
   *
   * AC: @mem-conversation ac-4 - Content reconstructed from events via TurnReconstructor
   */
  private async getTurnContent(turn: ConversationTurn): Promise<string> {
    if (!this.turnReconstructor) {
      return '';
    }
    return this.turnReconstructor.getContent(turn.session_id, turn.event_range);
  }

  /**
   * Generate a summary of conversation turns.
   *
   * AC: @mem-context-window ac-4 - Uses Haiku via ACP
   *
   * @param turns - Turns to summarize
   * @param sessionFileRef - Reference to the session file
   * @returns Summary text
   */
  async summarize(turns: ConversationTurn[], sessionFileRef: string): Promise<string> {
    // Format turns for the prompt (async to get content)
    const formattedTurnsList = await Promise.all(
      turns.map(async (turn) => {
        const content = await this.getTurnContent(turn);
        return `[${turn.role}]: ${content}`;
      })
    );
    const formattedTurns = formattedTurnsList.join('\n\n');

    const userPrompt = `Please summarize the following conversation history. Include a reference to the session file: ${sessionFileRef}

---
${formattedTurns}
---

Provide a concise summary (max ~${this.maxSummaryTokens} tokens) following the format specified.`;

    // Create a session for summarization
    const sessionId = await this.client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    // Collect response chunks
    const responseChunks: string[] = [];
    const updateHandler = (
      _sid: string,
      update: { sessionUpdate?: string; content?: { type?: string; text?: string } },
    ) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        responseChunks.push(update.content.text ?? '');
      }
    };

    this.client.on('update', updateHandler);

    try {
      // Send system prompt first
      await this.client.prompt({
        sessionId,
        prompt: [{ type: 'text', text: SUMMARY_SYSTEM_PROMPT }],
        promptSource: 'system',
      });

      // Send user prompt with turns
      await this.client.prompt({
        sessionId,
        prompt: [{ type: 'text', text: userPrompt }],
        promptSource: 'system', // System-initiated summarization
      });
    } finally {
      this.client.off('update', updateHandler);
    }

    return responseChunks.join('');
  }
}

/**
 * MockSummaryProvider for testing
 *
 * Generates deterministic summaries without ACP calls.
 * Uses a content map to provide mock content for turns.
 */
export class MockSummaryProvider implements SummaryProvider {
  private summaryCalls: Array<{ turns: ConversationTurn[]; sessionFileRef: string }> = [];
  private contentMap: Map<number, string> = new Map();
  private readonly turnReconstructor?: TurnReconstructor;

  constructor(options: { turnReconstructor?: TurnReconstructor } = {}) {
    this.turnReconstructor = options.turnReconstructor;
  }

  /**
   * Set mock content for a turn sequence number.
   */
  setContent(seq: number, content: string): void {
    this.contentMap.set(seq, content);
  }

  /**
   * Get content for a turn (from map, reconstructor, or empty string).
   */
  private async getTurnContent(turn: ConversationTurn): Promise<string> {
    // First check the content map
    const mapContent = this.contentMap.get(turn.seq);
    if (mapContent !== undefined) {
      return mapContent;
    }

    // Then try reconstructor
    if (this.turnReconstructor) {
      return this.turnReconstructor.getContent(turn.session_id, turn.event_range);
    }

    // Default to empty
    return '';
  }

  async summarize(turns: ConversationTurn[], sessionFileRef: string): Promise<string> {
    this.summaryCalls.push({ turns, sessionFileRef });

    // Get content for all turns
    const turnsWithContent = await Promise.all(
      turns.map(async (t) => ({
        turn: t,
        content: await this.getTurnContent(t),
      }))
    );

    // Extract topics from user turn content
    const topics = turnsWithContent
      .filter((t) => t.turn.role === 'user')
      .slice(0, 3)
      .map((t) => t.content.split(' ').slice(0, 5).join(' ') + '...');

    // Extract any instructions
    const instructions = turnsWithContent
      .filter((t) => t.turn.role === 'user' && /please|should|must|need/i.test(t.content))
      .slice(0, 2)
      .map((t) => t.content.slice(0, 50) + '...');

    return `## Topics Discussed
${topics.map((t) => `- ${t}`).join('\n')}

## Key Instructions/Notes
${instructions.length > 0 ? instructions.map((i) => `- ${i}`).join('\n') : '- No specific instructions noted'}

## Session Reference
For full conversation details, see: ${sessionFileRef}`;
  }

  /**
   * Get all calls made to summarize for testing assertions.
   */
  getSummaryCalls(): Array<{ turns: ConversationTurn[]; sessionFileRef: string }> {
    return this.summaryCalls;
  }

  /**
   * Clear recorded calls and content map.
   */
  clearCalls(): void {
    this.summaryCalls = [];
    this.contentMap.clear();
  }
}
