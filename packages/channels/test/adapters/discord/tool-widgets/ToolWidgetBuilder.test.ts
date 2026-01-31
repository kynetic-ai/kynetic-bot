/**
 * ToolWidgetBuilder Tests
 *
 * Tests for creating Discord embeds from tool calls.
 * AC: @discord-tool-widgets ac-1, ac-2, ac-3, ac-4, ac-6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ToolWidgetBuilder } from '../../../../src/adapters/discord/tool-widgets/ToolWidgetBuilder.js';
import type { ToolCall, ToolCallUpdate } from '@kynetic-bot/agent';

/**
 * Create a mock ToolCall
 */
function createMockToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: 'tc-123',
    title: 'Read file',
    kind: 'file',
    status: 'in_progress',
    ...overrides,
  } as ToolCall;
}

describe('ToolWidgetBuilder', () => {
  let builder: ToolWidgetBuilder;

  beforeEach(() => {
    builder = new ToolWidgetBuilder();
  });

  describe('buildWidget()', () => {
    // AC: @discord-tool-widgets ac-1 - Display tool calls as embeds
    it('should create embed with tool title', () => {
      const toolCall = createMockToolCall({ title: 'Read config.json' });

      const result = builder.buildWidget(toolCall);

      expect(result.embed).toBeInstanceOf(EmbedBuilder);
      const embedData = result.embed.toJSON();
      expect(embedData.title).toContain('Read config.json');
    });

    it('should use default title when none provided', () => {
      const toolCall = createMockToolCall({ title: undefined });

      const result = builder.buildWidget(toolCall);

      const embedData = result.embed.toJSON();
      expect(embedData.title).toContain('Tool Call');
    });

    it('should truncate long titles', () => {
      const longTitle = 'A'.repeat(200);
      const toolCall = createMockToolCall({ title: longTitle });

      const result = builder.buildWidget(toolCall);

      const embedData = result.embed.toJSON();
      // Title is: icon (emoji) + space + truncated text (90 chars + "... (truncated)")
      // Should be well under 200 chars
      expect(embedData.title!.length).toBeLessThan(120);
      expect(embedData.title).toContain('(truncated)');
    });

    // AC: @discord-tool-widgets ac-2, ac-3 - Status colors
    describe('status colors', () => {
      it('should use blue for in_progress status', () => {
        const toolCall = createMockToolCall({ status: 'in_progress' });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        expect(embedData.color).toBe(0x3498db); // Blue
      });

      it('should use green for completed status', () => {
        const toolCall = createMockToolCall({ status: 'completed' });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        expect(embedData.color).toBe(0x2ecc71); // Green
      });

      it('should use red for failed status', () => {
        const toolCall = createMockToolCall({ status: 'failed' });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        expect(embedData.color).toBe(0xe74c3c); // Red
      });

      it('should use status from update if provided', () => {
        const toolCall = createMockToolCall({ status: 'in_progress' });
        const update: ToolCallUpdate = { status: 'completed' } as ToolCallUpdate;

        const result = builder.buildWidget(toolCall, update);

        const embedData = result.embed.toJSON();
        expect(embedData.color).toBe(0x2ecc71); // Green (completed)
      });
    });

    // AC: @discord-tool-widgets ac-6 - Status footer
    describe('status footer', () => {
      it('should show status emoji in footer', () => {
        const toolCall = createMockToolCall({ status: 'completed' });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        expect(embedData.footer?.text).toContain('completed');
      });
    });

    describe('icons for tool kinds', () => {
      it('should show computer icon for bash kind', () => {
        const toolCall = createMockToolCall({ kind: 'bash' });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        expect(embedData.title).toMatch(/^💻/);
      });

      it('should show file icon for file kind', () => {
        const toolCall = createMockToolCall({ kind: 'file' });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        expect(embedData.title).toMatch(/^📄/);
      });

      it('should show search icon for search kind', () => {
        const toolCall = createMockToolCall({ kind: 'search' });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        expect(embedData.title).toMatch(/^🔍/);
      });

      it('should show web icon for web kind', () => {
        const toolCall = createMockToolCall({ kind: 'web' });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        expect(embedData.title).toMatch(/^🌐/);
      });

      it('should show gear icon for unknown kinds', () => {
        const toolCall = createMockToolCall({ kind: 'unknown' });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        expect(embedData.title).toMatch(/^⚙️/);
      });
    });

    describe('output display', () => {
      it('should display rawOutput as field', () => {
        const toolCall = createMockToolCall({
          rawOutput: 'file contents here',
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const outputField = embedData.fields?.find((f) => f.name === 'Output');
        expect(outputField).toBeDefined();
        expect(outputField?.value).toContain('file contents here');
      });

      it('should stringify non-string rawOutput', () => {
        const toolCall = createMockToolCall({
          rawOutput: { key: 'value' },
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const outputField = embedData.fields?.find((f) => f.name === 'Output');
        expect(outputField?.value).toContain('"key"');
        expect(outputField?.value).toContain('"value"');
      });

      it('should truncate long output', () => {
        const longOutput = 'A'.repeat(1000);
        const toolCall = createMockToolCall({
          rawOutput: longOutput,
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const outputField = embedData.fields?.find((f) => f.name === 'Output');
        expect(outputField?.value).toContain('(truncated)');
        expect(outputField?.value.length).toBeLessThan(900);
      });

      it('should display content array', () => {
        const toolCall = createMockToolCall({
          content: [{ type: 'content', text: 'Some content text' }],
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const contentField = embedData.fields?.find((f) => f.name === 'Content');
        expect(contentField).toBeDefined();
        expect(contentField?.value).toContain('Some content text');
      });

      it('should display diff content', () => {
        const toolCall = createMockToolCall({
          content: [{ type: 'diff', diff: '+ added line\n- removed line' }],
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const contentField = embedData.fields?.find((f) => f.name === 'Content');
        expect(contentField?.value).toContain('added line');
        expect(contentField?.value).toContain('removed line');
      });
    });

    // AC: @discord-tool-widgets ac-4 - Expand button
    describe('expand button', () => {
      it('should not include expand button for short output', () => {
        const toolCall = createMockToolCall({
          rawOutput: 'short output',
        });

        const result = builder.buildWidget(toolCall);

        expect(result.hasExpandButton).toBe(false);
        expect(result.components).toHaveLength(0);
      });

      it('should include expand button for truncated output', () => {
        const longOutput = 'A'.repeat(1000);
        const toolCall = createMockToolCall({
          rawOutput: longOutput,
        });

        const result = builder.buildWidget(toolCall);

        expect(result.hasExpandButton).toBe(true);
        expect(result.components).toHaveLength(1);
      });

      it('should create button with correct custom ID', () => {
        const longOutput = 'A'.repeat(1000);
        const toolCall = createMockToolCall({
          toolCallId: 'tc-abc123',
          rawOutput: longOutput,
        });

        const result = builder.buildWidget(toolCall);

        const row = result.components[0];
        const rowData = row.toJSON();
        expect(rowData.components[0]).toMatchObject({
          custom_id: 'expand:tc-abc123',
          label: 'Show Full Output',
          style: ButtonStyle.Secondary,
        });
      });

      it('should include expand button for truncated content', () => {
        const longContent = 'B'.repeat(1000);
        const toolCall = createMockToolCall({
          content: [{ type: 'content', text: longContent }],
        });

        const result = builder.buildWidget(toolCall);

        expect(result.hasExpandButton).toBe(true);
      });
    });

    // AC: @discord-tool-widgets ac-8 - Binary detection
    describe('binary content detection', () => {
      it('should detect content with null bytes as binary', () => {
        const binaryContent = 'some text\x00with null byte';
        const toolCall = createMockToolCall({
          rawOutput: binaryContent,
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const outputField = embedData.fields?.find((f) => f.name === 'Output');
        expect(outputField?.value).toContain('binary file');
        expect(outputField?.value).toContain('bytes');
        // Should not have expand button for binary content
        expect(result.hasExpandButton).toBe(false);
      });

      it('should detect content with high ratio of non-printable chars as binary', () => {
        // Create content with >10% non-printable characters (control chars)
        const chars = [];
        for (let i = 0; i < 100; i++) {
          if (i < 15) {
            chars.push(String.fromCharCode(0x01)); // Non-printable control char
          } else {
            chars.push('a');
          }
        }
        const binaryContent = chars.join('');
        const toolCall = createMockToolCall({
          rawOutput: binaryContent,
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const outputField = embedData.fields?.find((f) => f.name === 'Output');
        expect(outputField?.value).toContain('binary file');
      });

      it('should not detect normal text as binary', () => {
        const normalText = 'Hello world! This is normal text with some\nnewlines\tand tabs.';
        const toolCall = createMockToolCall({
          rawOutput: normalText,
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const outputField = embedData.fields?.find((f) => f.name === 'Output');
        expect(outputField?.value).toContain('Hello world');
        expect(outputField?.value).not.toContain('binary file');
      });

      it('should format bytes for small binary files', () => {
        const binaryContent = 'ab\x00cd'; // 5 bytes with null
        const toolCall = createMockToolCall({
          rawOutput: binaryContent,
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const outputField = embedData.fields?.find((f) => f.name === 'Output');
        expect(outputField?.value).toMatch(/\(binary file, \d+ bytes\)/);
      });

      it('should format KB for larger binary files', () => {
        // Create binary content >= 1024 bytes
        const binaryContent = '\x00'.repeat(2048);
        const toolCall = createMockToolCall({
          rawOutput: binaryContent,
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const outputField = embedData.fields?.find((f) => f.name === 'Output');
        expect(outputField?.value).toMatch(/\(binary file, [\d.]+ KB\)/);
      });

      it('should detect binary content in content array', () => {
        const binaryContent = 'diff content\x00with null byte';
        const toolCall = createMockToolCall({
          content: [{ type: 'diff', diff: binaryContent }],
        });

        const result = builder.buildWidget(toolCall);

        const embedData = result.embed.toJSON();
        const contentField = embedData.fields?.find((f) => f.name === 'Content');
        expect(contentField?.value).toContain('binary file');
        expect(result.hasExpandButton).toBe(false);
      });
    });
  });
});
