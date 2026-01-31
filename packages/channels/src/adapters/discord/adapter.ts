/**
 * Discord Channel Adapter
 *
 * Translates between Discord.js events and the platform-agnostic ChannelAdapter interface.
 *
 * @see @discord-channel-adapter
 */

import {
  Client,
  Events,
  ChannelType,
  type Message,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
  type ThreadChannel,
  DiscordAPIError,
} from 'discord.js';
import type { ChannelAdapter, NormalizedMessage } from '@kynetic-bot/core';
import { createLogger } from '@kynetic-bot/core';
import { DiscordAdapterConfigSchema, type DiscordAdapterConfig } from './config.js';
import {
  DiscordConnectionError,
  DiscordSendError,
  DiscordChannelNotFoundError,
  DiscordPermissionError,
} from './errors.js';
import { parseIncoming } from './parser.js';
import { splitMessage, splitMessageToEmbeds, EMBED_DESCRIPTION_MAX } from './splitter.js';
import type { ToolCall, ToolCallUpdate } from '@kynetic-bot/agent';
import {
  ToolWidgetBuilder,
  ToolCallTracker,
  MessageUpdateBatcher,
  type MessageEditFn,
} from './tool-widgets/index.js';

/**
 * Options for sending Discord messages
 */
export interface DiscordSendOptions {
  /** Reply to a specific message ID */
  replyTo?: string;
}

type MessageHandler = (message: NormalizedMessage) => void | Promise<void>;

/**
 * Type for Discord channels that support sending messages
 */
type SendableChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel;

/**
 * Discord channel adapter implementing the ChannelAdapter interface
 *
 * Handles:
 * - Message normalization (Discord.Message → NormalizedMessage)
 * - Message splitting for 2000 char limit
 * - Bot self-message filtering
 * - Thread and DM handling
 *
 * Relies on Discord.js for:
 * - Rate limiting (429 responses)
 * - WebSocket reconnection with exponential backoff
 */
export class DiscordAdapter implements ChannelAdapter {
  readonly platform = 'discord';

  private readonly config: DiscordAdapterConfig;
  private readonly client: Client;
  private readonly logger = createLogger('discord-adapter');
  private messageHandler: MessageHandler | null = null;
  private toolWidgetBuilder!: ToolWidgetBuilder;
  private toolCallTracker!: ToolCallTracker;
  private messageUpdateBatcher!: MessageUpdateBatcher;
  private botEventHandler: ((eventName: string, ...args: unknown[]) => void) | null = null;
  private isStarted = false;

  constructor(config: DiscordAdapterConfig) {
    // Validate config
    this.config = DiscordAdapterConfigSchema.parse(config);

    // Create Discord client with configured intents
    this.client = new Client({
      intents: this.config.intents,
      partials: this.config.partials,
    });

    this.setupEventHandlers();

    // Initialize tool widget system
    const editMessageFn: MessageEditFn = async (channelId, messageId, embeds, components) => {
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
          return null;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const message = await (channel as any).messages.fetch(messageId);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        return await message.edit({ embeds, components });
      } catch (error) {
        this.logger.error('Failed to edit message for tool widget', {
          channelId,
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    };

    this.messageUpdateBatcher = new MessageUpdateBatcher(editMessageFn);
    this.toolCallTracker = new ToolCallTracker(this.messageUpdateBatcher);
    this.toolWidgetBuilder = new ToolWidgetBuilder();
  }

  /**
   * Start the adapter and connect to Discord
   *
   * @throws DiscordConnectionError if login fails
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    this.logger.info('Starting Discord adapter...');

    try {
      // Wait for ready event before resolving
      const readyPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new DiscordConnectionError('Connection timeout'));
        }, 30000);

        this.client.once(Events.ClientReady, () => {
          clearTimeout(timeout);
          resolve();
        });

        this.client.once(Events.Error, (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      await this.client.login(this.config.token);
      await readyPromise;

      this.isStarted = true;
      this.logger.info(`Discord adapter started. Logged in as ${this.client.user?.tag}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new DiscordConnectionError(`Failed to connect to Discord: ${message}`, {
        error,
      });
    }
  }

  /**
   * Stop the adapter and disconnect from Discord
   */
  stop(): Promise<void> {
    if (!this.isStarted) {
      return Promise.resolve();
    }

    this.logger.info('Stopping Discord adapter...');

    void this.client.destroy();
    this.isStarted = false;
    // Cleanup tool widget system
    this.messageUpdateBatcher.stop();
    this.logger.info('Discord adapter stopped');

    return Promise.resolve();
  }

  /**
   * Send a message to a Discord channel
   *
   * Handles message splitting for long messages (AC-3).
   * Returns the message ID of the first message sent (AC-2).
   *
   * @param channel - Discord channel ID
   * @param text - Message text
   * @param options - Send options (replyTo, etc.)
   * @returns Message ID of the first message sent
   * @throws DiscordChannelNotFoundError if channel doesn't exist
   * @throws DiscordPermissionError if missing permissions
   * @throws DiscordSendError for other send failures
   */
  async sendMessage(channel: string, text: string, options?: DiscordSendOptions): Promise<string> {
    const discordChannel = await this.fetchChannel(channel);

    // Use configured strategy for handling long messages (AC-3)
    if (this.config.splitStrategy === 'embed') {
      return this.sendAsEmbeds(discordChannel, text, options);
    }

    return this.sendAsChunks(discordChannel, text, options);
  }

  /**
   * Send message as plain text chunks (split strategy)
   */
  private async sendAsChunks(
    discordChannel: SendableChannel,
    text: string,
    options?: DiscordSendOptions
  ): Promise<string> {
    const chunks = splitMessage(text, this.config.maxMessageLength);

    if (chunks.length === 0) {
      throw new DiscordSendError('Cannot send empty message', {
        channel: discordChannel.id,
      });
    }

    let firstMessageId: string | undefined;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isFirst = i === 0;

      try {
        const messageOptions: { content: string; reply?: { messageReference: string } } = {
          content: chunk,
        };

        // Only reply to the referenced message on the first chunk
        if (isFirst && options?.replyTo) {
          messageOptions.reply = { messageReference: options.replyTo };
        }

        const sentMessage = await discordChannel.send(messageOptions);

        if (isFirst) {
          firstMessageId = sentMessage.id;
        }
      } catch (error) {
        this.handleSendError(error, discordChannel.id);
      }
    }

    return firstMessageId!;
  }

  /**
   * Send message as Discord embeds (embed strategy)
   *
   * Uses embed description field which supports 4096 chars vs 2000 for regular messages.
   * Adds "Part X of Y" footer for multi-embed messages.
   */
  private async sendAsEmbeds(
    discordChannel: SendableChannel,
    text: string,
    options?: DiscordSendOptions
  ): Promise<string> {
    const embeds = splitMessageToEmbeds(text, EMBED_DESCRIPTION_MAX);

    if (embeds.length === 0) {
      throw new DiscordSendError('Cannot send empty message', {
        channel: discordChannel.id,
      });
    }

    let firstMessageId: string | undefined;

    for (let i = 0; i < embeds.length; i++) {
      const embed = embeds[i];
      const isFirst = i === 0;

      try {
        const messageOptions: {
          embeds: typeof embeds;
          reply?: { messageReference: string };
        } = {
          embeds: [embed],
        };

        // Only reply to the referenced message on the first embed
        if (isFirst && options?.replyTo) {
          messageOptions.reply = { messageReference: options.replyTo };
        }

        const sentMessage = await discordChannel.send(messageOptions);

        if (isFirst) {
          firstMessageId = sentMessage.id;
        }
      } catch (error) {
        this.handleSendError(error, discordChannel.id);
      }
    }

    return firstMessageId!;
  }

  /**
   * Edit an existing message
   *
   * Used for streaming responses where the bot edits its message
   * as more content becomes available.
   *
   * @param channel - Discord channel ID
   * @param messageId - ID of the message to edit
   * @param newText - New message text
   * @returns The message ID of the edited message
   * @throws DiscordSendError for edit failures
   */
  async editMessage(channel: string, messageId: string, newText: string): Promise<string> {
    const discordChannel = await this.fetchChannel(channel);

    try {
      // Fetch the message first
      const message = await discordChannel.messages.fetch(messageId);

      // Edit the message
      const editedMessage = await message.edit(newText);
      return editedMessage.id;
    } catch (error) {
      this.handleEditError(error, channel, messageId);
    }
  }

  /**
   * Register a handler for incoming messages
   *
   * @param handler - Callback invoked when messages are received
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Send a typing indicator to a Discord channel
   *
   * Shows the "Bot is typing..." indicator to users while processing.
   * The indicator automatically expires after ~10 seconds or when a
   * message is sent, so this is safe to call at the start of processing.
   *
   * @param channel - Discord channel ID
   * @throws DiscordChannelNotFoundError if channel doesn't exist
   * @throws DiscordPermissionError if missing permissions
   */
  async sendTyping(channel: string): Promise<void> {
    const discordChannel = await this.fetchChannel(channel);

    try {
      await discordChannel.sendTyping();
    } catch (error) {
      // Log but don't throw - typing indicator failure shouldn't block message processing
      this.logger.warn('Failed to send typing indicator', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Set up Discord.js event handlers
   */
  /**
   * Set up listeners for bot tool events
   * Should be called externally after adapter is created
   *
   * @param bot - Bot instance to listen to
   */
  setupBotEventListeners(bot: {
    on: (event: string, handler: (...args: any[]) => void) => void;
  }): void {
    // Register listeners
    bot.on('tool:call', (sessionId: string, channelId: string, toolCall: ToolCall) => {
      void this.handleToolCall(sessionId, channelId, toolCall);
    });

    bot.on(
      'tool:update',
      (sessionId: string, channelId: string, toolCallUpdate: ToolCallUpdate) => {
        void this.handleToolCallUpdate(sessionId, channelId, toolCallUpdate);
      }
    );

    this.logger.info('Bot event listeners registered for tool widgets');
  }

  /**
   * Handle tool call event
   *
   * AC: @discord-tool-widgets ac-1
   */
  private async handleToolCall(
    sessionId: string,
    channelId: string,
    toolCall: ToolCall
  ): Promise<void> {
    this.logger.debug('Tool call received', {
      toolCallId: toolCall.toolCallId,
      title: toolCall.title,
      sessionId,
    });

    try {
      // Build widget
      const widgetResult = this.toolWidgetBuilder.buildWidget(toolCall);

      // Track and send
      await this.toolCallTracker.trackToolCall(
        toolCall,
        sessionId,
        channelId,
        widgetResult,
        async (embeds, components) => {
          const channel = await this.fetchChannel(channelId);
          const message = await channel.send({ embeds, components });
          return message.id;
        }
      );
    } catch (error) {
      this.logger.error('Failed to handle tool call', {
        error: error instanceof Error ? error.message : String(error),
        toolCallId: toolCall.toolCallId,
      });
    }
  }

  /**
   * Handle tool call update event
   *
   * AC: @discord-tool-widgets ac-2, ac-3, ac-5, ac-6
   */
  private async handleToolCallUpdate(
    sessionId: string,
    channelId: string,
    toolCallUpdate: ToolCallUpdate
  ): Promise<void> {
    this.logger.debug('Tool call update received', {
      toolCallId: toolCallUpdate.toolCallId,
      status: toolCallUpdate.status,
      sessionId,
    });

    try {
      // Get the original tool call to build updated widget
      const allToolCalls = this.toolCallTracker.getAllToolCalls();
      const toolCallState = allToolCalls.find((tc) => tc.toolCallId === toolCallUpdate.toolCallId);

      if (!toolCallState) {
        this.logger.warn('Tool call not found for update', {
          toolCallId: toolCallUpdate.toolCallId,
        });
        return;
      }

      // Build updated widget
      const widgetResult = this.toolWidgetBuilder.buildWidget(
        toolCallState.toolCall,
        toolCallUpdate
      );

      // Update tracker
      await this.toolCallTracker.updateToolCall(
        toolCallUpdate.toolCallId,
        toolCallUpdate,
        widgetResult
      );
    } catch (error) {
      this.logger.error('Failed to handle tool call update', {
        error: error instanceof Error ? error.message : String(error),
        toolCallId: toolCallUpdate.toolCallId,
      });
    }
  }

  private setupEventHandlers(): void {
    // Handle incoming messages
    this.client.on(Events.MessageCreate, (message) => {
      void this.handleIncomingMessage(message);
    });

    // Handle button interactions for tool widget expand buttons
    // AC: @discord-tool-widgets ac-4
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) {
        return;
      }

      // Check if this is an expand button
      if (!interaction.customId.startsWith('expand:')) {
        return;
      }

      const toolCallId = interaction.customId.replace('expand:', '');

      try {
        // Get full output
        const fullOutput = this.toolCallTracker.getFullOutput(toolCallId);

        if (!fullOutput) {
          await interaction.reply({
            content: 'Output not available',
            ephemeral: true,
          });
          return;
        }

        // Send full output (not ephemeral per AC-4 correction)
        const reply = await interaction.reply({
          content: `\`\`\`\n${fullOutput.slice(0, 1900)}\n\`\`\``,
          fetchReply: true,
        });

        // Auto-delete after 60 seconds
        setTimeout(() => {
          if (reply && 'delete' in reply) {
            reply.delete().catch((err) => {
              this.logger.warn('Failed to auto-delete expand reply', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }, 60000);
      } catch (error) {
        this.logger.error('Failed to handle expand button', {
          error: error instanceof Error ? error.message : String(error),
          toolCallId,
        });
      }
    });

    // Connection state logging (AC-4: observability)
    this.client.on(Events.ShardReady, (shardId) => {
      this.logger.info(`Shard ${shardId} ready`);
    });

    this.client.on(Events.ShardReconnecting, (shardId) => {
      this.logger.info(`Shard ${shardId} reconnecting...`);
    });

    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      this.logger.info(`Shard ${shardId} resumed. Replayed ${replayedEvents} events`);
    });

    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      this.logger.warn(`Shard ${shardId} disconnected:`, event);
    });

    this.client.on(Events.Error, (error) => {
      this.logger.error('Discord client error:', error);
    });

    this.client.on(Events.Warn, (message) => {
      this.logger.warn('Discord client warning:', message);
    });

    // Rate limit logging for observability
    this.client.rest.on('rateLimited', (info) => {
      this.logger.warn('Discord rate limited', {
        route: info.route,
        method: info.method,
        limit: info.limit,
        retryAfter: info.retryAfter,
        global: info.global,
      });
    });
  }

  /**
   * Handle an incoming Discord message
   */
  private async handleIncomingMessage(message: Message): Promise<void> {
    if (!this.messageHandler) {
      return;
    }

    const botUserId = this.client.user?.id;
    if (!botUserId) {
      return;
    }

    try {
      // Parse and filter message (AC-1, AC-5, AC-6, AC-7)
      const normalized = await parseIncoming(message, botUserId);

      if (normalized) {
        await this.messageHandler(normalized);
      }
    } catch (error) {
      this.logger.error('Error handling incoming message:', error);
    }
  }

  /**
   * Fetch a Discord channel by ID
   */
  private async fetchChannel(channelId: string): Promise<SendableChannel> {
    try {
      const channel = await this.client.channels.fetch(channelId);

      if (!channel) {
        throw new DiscordChannelNotFoundError(channelId);
      }

      // Check for sendable channel types
      const sendableTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.GuildAnnouncement,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (!sendableTypes.includes(channel.type)) {
        throw new DiscordSendError('Channel does not support sending messages', {
          channelId,
          channelType: channel.type,
        });
      }

      return channel as SendableChannel;
    } catch (error) {
      if (error instanceof DiscordChannelNotFoundError) {
        throw error;
      }

      this.handleFetchError(error, channelId);
    }
  }

  /**
   * Handle Discord API errors when fetching channels
   */
  private handleFetchError(error: unknown, channelId: string): never {
    if (error instanceof DiscordAPIError) {
      // 10003: Unknown Channel
      if (error.code === 10003) {
        throw new DiscordChannelNotFoundError(channelId, {
          discordError: error.message,
        });
      }

      // 50001: Missing Access, 50013: Missing Permissions
      if (error.code === 50001 || error.code === 50013) {
        throw new DiscordPermissionError(`Missing permission to access channel: ${channelId}`, {
          channelId,
          discordError: error.message,
        });
      }
    }

    throw new DiscordSendError('Failed to fetch channel', {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Handle Discord API errors when sending messages
   */
  private handleSendError(error: unknown, channelId: string): never {
    if (error instanceof DiscordAPIError) {
      // 10003: Unknown Channel
      if (error.code === 10003) {
        throw new DiscordChannelNotFoundError(channelId, {
          discordError: error.message,
        });
      }

      // 50001: Missing Access, 50013: Missing Permissions
      if (error.code === 50001 || error.code === 50013) {
        throw new DiscordPermissionError(
          `Missing permission to send message to channel: ${channelId}`,
          { channelId, discordError: error.message }
        );
      }

      // 10008: Unknown Message (for replies)
      if (error.code === 10008) {
        throw new DiscordSendError('Referenced message not found', {
          channelId,
          discordError: error.message,
        });
      }
    }

    throw new DiscordSendError('Failed to send message', {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Handle Discord API errors when editing messages
   */
  private handleEditError(error: unknown, channelId: string, messageId: string): never {
    if (error instanceof DiscordAPIError) {
      // 10008: Unknown Message
      if (error.code === 10008) {
        throw new DiscordSendError('Message not found for edit', {
          channelId,
          messageId,
          discordError: error.message,
        });
      }

      // 50001: Missing Access, 50013: Missing Permissions
      if (error.code === 50001 || error.code === 50013) {
        throw new DiscordPermissionError(
          `Missing permission to edit message in channel: ${channelId}`,
          { channelId, messageId, discordError: error.message }
        );
      }

      // 50005: Cannot edit a message authored by another user
      if (error.code === 50005) {
        throw new DiscordPermissionError('Cannot edit message authored by another user', {
          channelId,
          messageId,
          discordError: error.message,
        });
      }
    }

    throw new DiscordSendError('Failed to edit message', {
      channelId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
