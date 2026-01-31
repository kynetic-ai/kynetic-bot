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

/** Truncation marker appended when hard-cutting */
const TRUNCATION_MARKER = '... [truncated]';

/** Result of finding a split point */
interface SplitPointResult {
  index: number;
  hardCut: boolean;
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
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Check if we're starting inside a code block from previous chunk
    const prefix = inCodeBlock ? `\`\`\`${codeBlockLang}\n` : '';
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
    if (remaining.length <= maxLength) {
      embeds.push({ description: remaining });
      break;
    }

    // Check if we're starting inside a code block from previous chunk
    const prefix = inCodeBlock ? `\`\`\`${codeBlockLang}\n` : '';
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
