/**
 * Discord Message Splitter
 *
 * Handles splitting long messages to fit Discord's limits.
 * Supports two strategies:
 * - split: Multiple plain text messages (2000 char limit each)
 * - embed: Discord embeds (4096 char description limit each)
 */

import type { APIEmbed } from 'discord.js';

/** Maximum length for embed description */
export const EMBED_DESCRIPTION_MAX = 4096;

/** Default Discord message limit */
export const DISCORD_MESSAGE_MAX = 2000;

/** Default soft limit for preemptive splitting (90% of max) */
export const DEFAULT_SOFT_LIMIT = 1800;

/**
 * Decision returned by StreamingSplitTracker.push()
 */
export type SplitDecision =
  | { action: 'continue' } // Keep accumulating, under soft limit
  | { action: 'buffer' } // Near limit but in code block, wait for it to close
  | { action: 'split'; chunks: string[] }; // Split now, return chunks

/** Truncation marker appended when hard-cutting */
const TRUNCATION_MARKER = '... [truncated]';

/** Result of finding a split point */
interface SplitPointResult {
  index: number;
  hardCut: boolean;
}

/**
 * Find the best split point within the maximum length
 *
 * Priority: newline > space > hard cut
 */
function findSplitPoint(text: string, maxLength: number): SplitPointResult {
  // Look for a newline within the last 20% of the allowed length
  const searchStart = Math.floor(maxLength * 0.8);
  const searchRegion = text.slice(searchStart, maxLength);

  // Prefer splitting at blank lines (double newline)
  const blankLineIndex = searchRegion.lastIndexOf('\n\n');
  if (blankLineIndex !== -1) {
    return { index: searchStart + blankLineIndex + 1, hardCut: false };
  }

  // Try single newline
  const newlineIndex = searchRegion.lastIndexOf('\n');
  if (newlineIndex !== -1) {
    return { index: searchStart + newlineIndex + 1, hardCut: false };
  }

  // Try space
  const spaceIndex = searchRegion.lastIndexOf(' ');
  if (spaceIndex !== -1) {
    return { index: searchStart + spaceIndex + 1, hardCut: false };
  }

  // Last resort: hard cut at maxLength
  // If the entire chunk has no good split points, truncate with marker
  if (maxLength < text.length) {
    // Reserve space for truncation marker
    return { index: maxLength - TRUNCATION_MARKER.length, hardCut: true };
  }

  return { index: maxLength, hardCut: false };
}

/**
 * Track whether we're inside a code block after processing text
 */
function trackCodeBlockState(
  text: string,
  startInCodeBlock: boolean,
  startLang: string
): { inCodeBlock: boolean; lang: string } {
  let inCodeBlock = startInCodeBlock;
  let lang = startLang;

  // Match code block markers
  const codeBlockRegex = /```(\w*)?/g;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (inCodeBlock) {
      // Closing code block
      inCodeBlock = false;
      lang = '';
    } else {
      // Opening code block
      inCodeBlock = true;
      lang = match[1] || '';
    }
  }

  return { inCodeBlock, lang };
}

/**
 * Split a message into chunks that fit within Discord's character limit
 *
 * Splitting strategy (AC-3):
 * 1. Try to split at newlines
 * 2. Fall back to splitting at spaces
 * 3. Last resort: hard cut with truncation marker
 *
 * Preserves code block fencing when splitting inside code blocks.
 *
 * @param text - Message text to split
 * @param maxLength - Maximum length per chunk (default: 2000)
 * @returns Array of message chunks
 */
export function splitMessage(text: string, maxLength = 2000): string[] {
  // Handle edge cases
  if (!text || text.length === 0) {
    return [];
  }

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    // Check if we're starting inside a code block from previous chunk
    const prefix = inCodeBlock ? `\`\`\`${codeBlockLang}\n` : '';

    if (remaining.length + prefix.length <= maxLength) {
      // Remaining fits with prefix, push as final chunk
      const finalChunk = prefix + remaining;
      chunks.push(finalChunk.trim());
      break;
    }
    const effectiveMaxLength = maxLength - prefix.length;

    // Find a good split point
    const splitResult = findSplitPoint(remaining, effectiveMaxLength);
    const splitIndex = splitResult.index;

    // Extract the chunk
    let chunk = remaining.slice(0, splitIndex);

    // Append truncation marker if hard-cutting
    if (splitResult.hardCut) {
      chunk += TRUNCATION_MARKER;
    }

    // Track code block state (before adding truncation marker)
    const codeBlockState = trackCodeBlockState(
      remaining.slice(0, splitIndex),
      inCodeBlock,
      codeBlockLang
    );

    // If we're ending mid-code-block, close it and prepare to reopen
    let suffix = '';
    if (codeBlockState.inCodeBlock) {
      suffix = '\n```';
      inCodeBlock = true;
      codeBlockLang = codeBlockState.lang;
    } else {
      inCodeBlock = false;
      codeBlockLang = '';
    }

    // Assemble final chunk
    chunk = prefix + chunk + suffix;
    chunks.push(chunk.trim());

    // Move to remaining text
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Split a message into Discord embeds
 *
 * Embed strategy (AC-3):
 * - Uses embed description field (4096 char limit vs 2000 for regular messages)
 * - Preserves code block formatting across splits
 * - Adds continuation indicators for multi-embed messages
 *
 * @param text - Message text to split
 * @param maxLength - Maximum embed description length (default: 4096)
 * @returns Array of embed objects
 */
export function splitMessageToEmbeds(text: string, maxLength = EMBED_DESCRIPTION_MAX): APIEmbed[] {
  // Handle edge cases
  if (!text || text.length === 0) {
    return [];
  }

  if (text.length <= maxLength) {
    return [{ description: text }];
  }

  const embeds: APIEmbed[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    // Check if we're starting inside a code block from previous chunk
    const prefix = inCodeBlock ? `\`\`\`${codeBlockLang}\n` : '';

    if (remaining.length + prefix.length <= maxLength) {
      // Remaining fits with prefix, push as final embed
      const finalChunk = prefix + remaining;
      embeds.push({ description: finalChunk.trim() });
      break;
    }
    const effectiveMaxLength = maxLength - prefix.length;

    // Find a good split point
    const splitResult = findSplitPoint(remaining, effectiveMaxLength);
    const splitIndex = splitResult.index;

    // Extract the chunk
    let chunk = remaining.slice(0, splitIndex);

    // Append truncation marker if hard-cutting
    if (splitResult.hardCut) {
      chunk += TRUNCATION_MARKER;
    }

    // Track code block state (before adding truncation marker)
    const codeBlockState = trackCodeBlockState(
      remaining.slice(0, splitIndex),
      inCodeBlock,
      codeBlockLang
    );

    // If we're ending mid-code-block, close it and prepare to reopen
    let suffix = '';
    if (codeBlockState.inCodeBlock) {
      suffix = '\n```';
      inCodeBlock = true;
      codeBlockLang = codeBlockState.lang;
    } else {
      inCodeBlock = false;
      codeBlockLang = '';
    }

    // Assemble final chunk
    chunk = prefix + chunk + suffix;
    const trimmedChunk = chunk.trim();

    if (trimmedChunk.length > 0) {
      embeds.push({ description: trimmedChunk });
    }

    // Move to remaining text
    remaining = remaining.slice(splitIndex).trimStart();
  }

  // Add continuation indicators if multiple embeds
  if (embeds.length > 1) {
    embeds.forEach((embed, index) => {
      embed.footer = { text: `Part ${index + 1} of ${embeds.length}` };
    });
  }

  return embeds;
}

/**
 * StreamingSplitTracker - Tracks streaming text and decides when to split
 *
 * Implements AC-5 and AC-6 for @discord-channel-adapter:
 * - AC-5: Splits at semantic boundaries when content exceeds Discord limit
 * - AC-6: Buffers code blocks, preemptively splits before them, or closes/reopens
 *
 * Usage:
 * ```typescript
 * const tracker = new StreamingSplitTracker();
 *
 * onChunk: (chunk) => {
 *   const decision = tracker.push(displayText);
 *   if (decision.action === 'split') {
 *     // Send decision.chunks as messages
 *     tracker.reset();
 *   }
 * }
 *
 * onComplete: () => {
 *   const remaining = tracker.finalize();
 *   // Send remaining chunks
 * }
 * ```
 */
export class StreamingSplitTracker {
  private text = '';
  private inCodeBlock = false;
  private codeBlockLang = '';

  constructor(
    private readonly maxLength = DISCORD_MESSAGE_MAX,
    private readonly softLimit = DEFAULT_SOFT_LIMIT
  ) {}

  /**
   * Process incoming text and decide what to do
   *
   * Note: The `text` parameter is the FULL accumulated display text,
   * not just the new chunk. The tracker replaces its internal state
   * with this text each call.
   */
  push(text: string): SplitDecision {
    this.text = text;
    this.updateCodeBlockState();

    const length = this.text.length;

    // Under soft limit - keep going
    if (length < this.softLimit) {
      return { action: 'continue' };
    }

    // Between soft and hard limit
    if (length < this.maxLength) {
      // Check if a code block JUST started (within last 100 chars)
      // If so, preemptively split BEFORE it
      const tail = this.text.slice(-100);
      const codeBlockMatch = tail.match(/```(\w*)?$/);
      if (codeBlockMatch) {
        // Split before the code block
        const splitPoint = this.text.length - codeBlockMatch[0].length;
        if (splitPoint > 0) {
          const beforeCodeBlock = this.text.slice(0, splitPoint).trimEnd();
          const codeBlockStart = this.text.slice(splitPoint);
          return {
            action: 'split',
            chunks: [beforeCodeBlock, codeBlockStart],
          };
        }
      }

      // If in a code block (and not at the start), buffer to let it complete
      if (this.inCodeBlock) {
        return { action: 'buffer' };
      }

      // Otherwise continue accumulating
      return { action: 'continue' };
    }

    // Over hard limit - must split
    const chunks = splitMessage(this.text, this.maxLength);
    return { action: 'split', chunks };
  }

  /**
   * Get the currently accumulated text
   */
  getText(): string {
    return this.text;
  }

  /**
   * Reset tracker state after a split
   *
   * Call this after handling a split decision to start fresh.
   * The remainingText parameter is the text that wasn't sent
   * (e.g., overflow chunks that will become new messages).
   */
  reset(remainingText = ''): void {
    this.text = remainingText;
    this.updateCodeBlockState();
  }

  /**
   * Finalize and get any remaining content
   *
   * Call this when streaming is complete to get the final chunk(s).
   */
  finalize(): string[] {
    if (!this.text || this.text.trim().length === 0) {
      return [];
    }

    // If text exceeds limit, split it
    if (this.text.length > this.maxLength) {
      return splitMessage(this.text, this.maxLength);
    }

    return [this.text];
  }

  /**
   * Check if currently inside a code block
   */
  isInCodeBlock(): boolean {
    return this.inCodeBlock;
  }

  /**
   * Update code block tracking state based on current text
   */
  private updateCodeBlockState(): void {
    const state = trackCodeBlockState(this.text, false, '');
    this.inCodeBlock = state.inCodeBlock;
    this.codeBlockLang = state.lang;
  }
}
