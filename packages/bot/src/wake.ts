/**
 * Wake context prompt generation
 *
 * Generates wake-up prompts for bot restarts. When the bot restarts with a
 * checkpoint, the wake prompt is injected before the identity prompt to provide
 * restart context.
 *
 * @see @wake-injection
 */

import type { WakeContext } from '@kynetic-bot/supervisor';

/**
 * Maximum length for wake prompt (characters)
 * If exceeded, truncate with warning and preserve essential info
 * AC: @wake-injection ac-8
 */
const MAX_WAKE_PROMPT_LENGTH = 10000;

/**
 * Generate wake prompt from checkpoint wake context
 *
 * AC: @wake-injection ac-4, ac-5, ac-8
 *
 * @param wakeContext - Wake context from checkpoint
 * @returns Generated wake prompt
 */
export function generateWakePrompt(wakeContext: WakeContext): string {
  // Start with the base prompt from checkpoint
  // AC: @wake-injection ac-4, ac-5
  let prompt = wakeContext.prompt;

  // Add pending work if present
  if (wakeContext.pending_work) {
    prompt += `\n\nYou were working on: ${wakeContext.pending_work}`;
  }

  // Add instructions if present
  if (wakeContext.instructions) {
    prompt += `\n\nInstructions: ${wakeContext.instructions}`;
  }

  // AC: @wake-injection ac-8 - Truncate if too large
  if (prompt.length > MAX_WAKE_PROMPT_LENGTH) {
    // Preserve essential info: restart reason, pending work, and start of instructions
    const parts: string[] = [wakeContext.prompt];

    if (wakeContext.pending_work) {
      parts.push(`You were working on: ${wakeContext.pending_work}`);
    }

    // Calculate remaining space for instructions
    const baseLength = parts.join('\n\n').length;
    const remainingSpace = MAX_WAKE_PROMPT_LENGTH - baseLength - 200; // Reserve space for warning

    if (wakeContext.instructions && remainingSpace > 100) {
      const truncatedInstructions = wakeContext.instructions.slice(0, remainingSpace);
      parts.push(`Instructions: ${truncatedInstructions}... [TRUNCATED]`);
    }

    const truncatedPrompt = parts.join('\n\n');
    const warning = `\n\n[Warning: Wake context was truncated due to size (${prompt.length} chars). Essential information preserved.]`;

    return truncatedPrompt + warning;
  }

  return prompt;
}
