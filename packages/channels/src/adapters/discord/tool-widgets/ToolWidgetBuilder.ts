/**
 * ToolWidgetBuilder - Factory for creating Discord embeds for tool calls
 *
 * Uses actual SDK ToolCall types (title, kind, rawInput, rawOutput, status, content)
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import type { ToolCall, ToolCallUpdate } from '@kynetic-bot/agent';

const STATUS_COLORS = {
  in_progress: 0x3498db, // Blue
  completed: 0x2ecc71, // Green
  failed: 0xe74c3c, // Red
} as const;

const STATUS_EMOJIS = {
  in_progress: '▶️',
  completed: '✅',
  failed: '❌',
} as const;

const MAX_OUTPUT_LENGTH = 800;

export interface WidgetResult {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
  hasExpandButton: boolean;
}

export class ToolWidgetBuilder {
  buildWidget(toolCall: ToolCall, update?: ToolCallUpdate): WidgetResult {
    const title = toolCall.title || 'Tool Call';
    const status = (update?.status ||
      toolCall.status ||
      'in_progress') as keyof typeof STATUS_COLORS;
    const icon = this.getIconForKind(toolCall.kind);

    const embed = new EmbedBuilder()
      .setColor(STATUS_COLORS[status] || STATUS_COLORS.in_progress)
      .setTitle(`${icon} ${this.truncate(title, 100)}`);

    // Add output if available
    let hasOutput = false;
    if (toolCall.rawOutput) {
      const output =
        typeof toolCall.rawOutput === 'string'
          ? toolCall.rawOutput
          : JSON.stringify(toolCall.rawOutput);
      const truncated = this.truncate(output, MAX_OUTPUT_LENGTH);
      embed.addFields({
        name: 'Output',
        value: `\`\`\`\n${truncated}\n\`\`\``,
        inline: false,
      });
      hasOutput = output.length > MAX_OUTPUT_LENGTH;
    }

    // Add content if available
    if (toolCall.content && toolCall.content.length > 0) {
      const contentText = toolCall.content
        .map((c: { type?: string; text?: string; diff?: string }) => {
          if (c.type === 'content' && c.text) return c.text;
          if (c.type === 'diff' && c.diff) return c.diff;
          return '';
        })
        .filter(Boolean)
        .join('\n');

      if (contentText) {
        const truncated = this.truncate(contentText, MAX_OUTPUT_LENGTH);
        embed.addFields({
          name: 'Content',
          value: `\`\`\`\n${truncated}\n\`\`\``,
          inline: false,
        });
        hasOutput = hasOutput || contentText.length > MAX_OUTPUT_LENGTH;
      }
    }

    // Add status footer
    const statusEmoji = STATUS_EMOJIS[status] || STATUS_EMOJIS.in_progress;
    embed.setFooter({ text: `${statusEmoji} ${status}` });

    // Add expand button if there's truncated output
    const hasExpandButton = hasOutput;
    const components = hasExpandButton ? [this.buildExpandButton(toolCall.toolCallId)] : [];

    return { embed, components, hasExpandButton };
  }

  private getIconForKind(kind?: string): string {
    const icons: Record<string, string> = {
      bash: '💻',
      shell: '💻',
      file: '📄',
      search: '🔍',
      web: '🌐',
    };
    return icons[kind || ''] || '⚙️';
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength - 10) + '\n... (truncated)';
  }

  private buildExpandButton(toolCallId: string): ActionRowBuilder<ButtonBuilder> {
    const button = new ButtonBuilder()
      .setCustomId(`expand:${toolCallId}`)
      .setLabel('Show Full Output')
      .setStyle(ButtonStyle.Secondary);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  }
}
