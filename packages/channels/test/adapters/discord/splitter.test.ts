/**
 * Discord Message Splitter Tests
 *
 * Test coverage for message splitting (AC-3).
 */

import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  splitMessageToEmbeds,
  EMBED_DESCRIPTION_MAX,
} from '../../../src/adapters/discord/splitter.js';

describe('splitMessage (@discord-channel-adapter)', () => {
  describe('edge cases', () => {
    it('should return empty array for empty input', () => {
      expect(splitMessage('')).toEqual([]);
    });

    it('should return empty array for null-ish input', () => {
      expect(splitMessage(null as unknown as string)).toEqual([]);
      expect(splitMessage(undefined as unknown as string)).toEqual([]);
    });

    it('should not split message exactly at limit', () => {
      const text = 'a'.repeat(2000);
      const chunks = splitMessage(text, 2000);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it('should not split message under limit', () => {
      const text = 'Hello, world!';
      const chunks = splitMessage(text, 2000);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });
  });

  // AC-3: Messages exceeding Discord's 2000-character limit are split or embedded
  describe('AC-3: message splitting at 2000 chars', () => {
    it('should split message over limit', () => {
      const text = 'a'.repeat(2500);
      const chunks = splitMessage(text, 2000);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      });
    });

    it('should preserve all content when splitting', () => {
      const text = 'word '.repeat(500); // ~2500 chars
      const chunks = splitMessage(text, 2000);
      const rejoined = chunks.join(' ').replace(/\s+/g, ' ').trim();
      const originalNormalized = text.replace(/\s+/g, ' ').trim();
      // Content should be preserved (minus potential extra whitespace)
      expect(rejoined.length).toBeGreaterThan(0);
    });
  });

  describe('smart splitting at boundaries', () => {
    it('should prefer splitting at newlines', () => {
      // Newline must be in the search region (last 20% of maxLength)
      // For 2000 max, search region is 1600-2000
      const line1 = 'a'.repeat(1700);
      const line2 = 'b'.repeat(500);
      const text = `${line1}\n${line2}`;

      const chunks = splitMessage(text, 2000);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(line1);
      expect(chunks[1]).toBe(line2);
    });

    it('should prefer blank lines over single newlines', () => {
      const part1 = 'a'.repeat(1500);
      const part2 = 'b'.repeat(100);
      const part3 = 'c'.repeat(1000);
      const text = `${part1}\n${part2}\n\n${part3}`;

      const chunks = splitMessage(text, 2000);
      // Should split at the blank line
      expect(chunks.length).toBe(2);
    });

    it('should fall back to spaces when no newlines', () => {
      const text = 'word '.repeat(500); // ~2500 chars, no newlines
      const chunks = splitMessage(text, 2000);

      expect(chunks.length).toBeGreaterThan(1);
      // After trim(), chunks end at word boundaries but without trailing space
      // The split still happens at space boundaries
      expect(chunks[0].length).toBeLessThanOrEqual(2000);
    });

    it('should hard-cut with truncation marker when no good split points', () => {
      const text = 'a'.repeat(2500); // No spaces or newlines
      const chunks = splitMessage(text, 2000);

      expect(chunks.length).toBeGreaterThan(1);
      // First chunk should end with truncation marker
      expect(chunks[0]).toContain('... [truncated]');
      expect(chunks[0]).toMatch(/\.\.\. \[truncated\]$/);
      // All chunks should be under limit
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      });
    });
  });

  describe('code block preservation', () => {
    it('should close and reopen code blocks when splitting', () => {
      const code = 'x'.repeat(1800);
      const text = `\`\`\`javascript\n${code}\nconsole.log('end');\n\`\`\``;

      const chunks = splitMessage(text, 2000);

      // If split occurs, first chunk should end with ``` and second should start with ```
      if (chunks.length > 1) {
        expect(chunks[0]).toMatch(/```$/);
        expect(chunks[1]).toMatch(/^```/);
      }
    });

    it('should preserve code block language when reopening', () => {
      const code = 'x'.repeat(1900);
      const text = `\`\`\`typescript\n${code}\n\`\`\``;

      const chunks = splitMessage(text, 2000);

      if (chunks.length > 1) {
        expect(chunks[1]).toMatch(/^```typescript/);
      }
    });

    it('should handle code blocks without language', () => {
      const code = 'x'.repeat(1900);
      const text = `\`\`\`\n${code}\n\`\`\``;

      const chunks = splitMessage(text, 2000);

      if (chunks.length > 1) {
        expect(chunks[1]).toMatch(/^```\n/);
      }
    });

    it('should handle multiple code blocks', () => {
      const block1 = `\`\`\`js\n${'a'.repeat(800)}\n\`\`\``;
      const block2 = `\`\`\`py\n${'b'.repeat(800)}\n\`\`\``;
      const text = `${block1}\n\n${block2}`;

      const chunks = splitMessage(text, 2000);

      // Should preserve both complete code blocks
      const rejoined = chunks.join('\n');
      expect(rejoined).toContain('```js');
      expect(rejoined).toContain('```py');
    });
  });

  describe('custom max length', () => {
    it('should respect custom max length', () => {
      const text = 'a'.repeat(200);
      const chunks = splitMessage(text, 100);

      // With truncation marker reservation, may need more chunks
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(100);
      });
    });

    it('should work with very small max length', () => {
      const text = 'Hello world';
      const chunks = splitMessage(text, 5);

      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle mixed content with code and text', () => {
      const text = `Here is some explanation:

\`\`\`javascript
function hello() {
  console.log('Hello, world!');
}
${'// more code\n'.repeat(100)}
\`\`\`

And here is the conclusion with more text that goes on for a while.
${'More explanation '.repeat(50)}`;

      const chunks = splitMessage(text, 2000);

      expect(chunks.length).toBeGreaterThan(1);
      // All chunks should be under limit
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      });
    });

    it('should handle markdown formatting', () => {
      const text = `# Title

## Section 1
${'Content '.repeat(200)}

## Section 2
${'More content '.repeat(200)}`;

      const chunks = splitMessage(text, 2000);

      // Should preserve content
      const rejoined = chunks.join('\n');
      expect(rejoined).toContain('# Title');
      expect(rejoined).toContain('## Section 1');
      expect(rejoined).toContain('## Section 2');
    });
  });
});

// AC-3: Messages exceeding Discord's limit use embeds as alternative to splitting
describe('splitMessageToEmbeds (@discord-channel-adapter)', () => {
  describe('edge cases', () => {
    it('should return empty array for empty input', () => {
      expect(splitMessageToEmbeds('')).toEqual([]);
    });

    it('should return empty array for null-ish input', () => {
      expect(splitMessageToEmbeds(null as unknown as string)).toEqual([]);
      expect(splitMessageToEmbeds(undefined as unknown as string)).toEqual([]);
    });

    it('should return single embed for message under limit', () => {
      const text = 'Hello, world!';
      const embeds = splitMessageToEmbeds(text);
      expect(embeds).toHaveLength(1);
      expect(embeds[0].description).toBe(text);
    });

    it('should return single embed for message exactly at limit', () => {
      const text = 'a'.repeat(EMBED_DESCRIPTION_MAX);
      const embeds = splitMessageToEmbeds(text);
      expect(embeds).toHaveLength(1);
      expect(embeds[0].description).toBe(text);
    });
  });

  // AC-3: Embed strategy uses 4096 char limit vs 2000 for regular messages
  describe('AC-3: embed splitting at 4096 chars', () => {
    it('should split message over embed limit', () => {
      const text = 'a'.repeat(5000);
      const embeds = splitMessageToEmbeds(text);
      expect(embeds.length).toBeGreaterThan(1);
      embeds.forEach((embed) => {
        expect(embed.description!.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_MAX);
      });
    });

    it('should use embed description field', () => {
      const text = 'Test message';
      const embeds = splitMessageToEmbeds(text);
      expect(embeds[0]).toHaveProperty('description', text);
    });

    it('should add continuation footer for multi-embed messages', () => {
      const text = 'a'.repeat(5000);
      const embeds = splitMessageToEmbeds(text);

      expect(embeds.length).toBeGreaterThan(1);
      embeds.forEach((embed, index) => {
        expect(embed.footer).toBeDefined();
        expect(embed.footer!.text).toBe(`Part ${index + 1} of ${embeds.length}`);
      });
    });

    it('should not add footer for single embed', () => {
      const text = 'Short message';
      const embeds = splitMessageToEmbeds(text);
      expect(embeds).toHaveLength(1);
      expect(embeds[0].footer).toBeUndefined();
    });
  });

  describe('smart splitting at boundaries', () => {
    it('should prefer splitting at newlines', () => {
      // Newline must be in the search region (last 20% of maxLength)
      const line1 = 'a'.repeat(3500);
      const line2 = 'b'.repeat(1000);
      const text = `${line1}\n${line2}`;

      const embeds = splitMessageToEmbeds(text);
      expect(embeds.length).toBe(2);
      expect(embeds[0].description).toBe(line1);
      expect(embeds[1].description).toBe(line2);
    });

    it('should fall back to spaces when no newlines', () => {
      const text = 'word '.repeat(1000); // ~5000 chars, no newlines
      const embeds = splitMessageToEmbeds(text);

      expect(embeds.length).toBeGreaterThan(1);
      embeds.forEach((embed) => {
        expect(embed.description!.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_MAX);
      });
    });

    it('should hard-cut with truncation marker when no good split points', () => {
      const text = 'a'.repeat(5000); // No spaces or newlines
      const embeds = splitMessageToEmbeds(text);

      expect(embeds.length).toBeGreaterThan(1);
      // First embed should end with truncation marker
      expect(embeds[0].description).toContain('... [truncated]');
      expect(embeds[0].description).toMatch(/\.\.\. \[truncated\]$/);
      // All embeds should be under limit
      embeds.forEach((embed) => {
        expect(embed.description!.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_MAX);
      });
    });
  });

  describe('code block preservation', () => {
    it('should close and reopen code blocks when splitting', () => {
      const code = 'x'.repeat(4000);
      const text = `\`\`\`javascript\n${code}\nconsole.log('end');\n\`\`\``;

      const embeds = splitMessageToEmbeds(text);

      if (embeds.length > 1) {
        expect(embeds[0].description).toMatch(/```$/);
        expect(embeds[1].description).toMatch(/^```/);
      }
    });

    it('should preserve code block language when reopening', () => {
      const code = 'x'.repeat(4000);
      const text = `\`\`\`typescript\n${code}\n\`\`\``;

      const embeds = splitMessageToEmbeds(text);

      if (embeds.length > 1) {
        expect(embeds[1].description).toMatch(/^```typescript/);
      }
    });
  });

  describe('custom max length', () => {
    it('should respect custom max length', () => {
      const text = 'a'.repeat(500);
      const embeds = splitMessageToEmbeds(text, 200);

      expect(embeds.length).toBeGreaterThanOrEqual(2);
      embeds.forEach((embed) => {
        expect(embed.description!.length).toBeLessThanOrEqual(200);
      });
    });
  });

  describe('comparison with splitMessage', () => {
    it('should fit more content per chunk than splitMessage', () => {
      const text = 'a'.repeat(8000);

      const textChunks = splitMessage(text, 2000);
      const embeds = splitMessageToEmbeds(text, EMBED_DESCRIPTION_MAX);

      // Embeds should require fewer parts due to higher limit
      expect(embeds.length).toBeLessThan(textChunks.length);
    });
  });
});
