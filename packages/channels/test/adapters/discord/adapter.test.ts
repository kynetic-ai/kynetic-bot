/**
 * Discord Adapter Tests
 *
 * Test coverage for the main Discord adapter class.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Events, DiscordAPIError, ChannelType } from 'discord.js';
import type { Message, TextChannel } from 'discord.js';

// Use a global variable to track mock client since vi.mock is hoisted
const mockClientRef: { current: ReturnType<typeof createMockClientInstance> | null } = {
  current: null,
};

function createMockClientInstance() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    user: { id: 'bot-user-id', tag: 'TestBot#1234' },
    login: vi.fn().mockResolvedValue('token'),
    destroy: vi.fn(),
    channels: {
      fetch: vi.fn(),
    },
  });
}

// Mock discord.js - define everything inside the factory
vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  const { EventEmitter } = await import('events');

  return {
    ...actual,
    Client: class MockClient extends EventEmitter {
      user = { id: 'bot-user-id', tag: 'TestBot#1234' };
      login = vi.fn().mockResolvedValue('token');
      destroy = vi.fn();
      channels = { fetch: vi.fn() };
      rest = new EventEmitter();

      constructor(_options: unknown) {
        super();
        // Use the external ref
        (globalThis as Record<string, unknown>).__mockClientRef = this;
      }
    },
  };
});

import { DiscordAdapter } from '../../../src/adapters/discord/adapter.js';
import {
  DiscordConnectionError,
  DiscordChannelNotFoundError,
  DiscordPermissionError,
  DiscordSendError,
} from '../../../src/adapters/discord/errors.js';

// Helper to get the current mock client
function getMockClient() {
  return (globalThis as Record<string, unknown>).__mockClientRef as EventEmitter & {
    user: { id: string; tag: string };
    login: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    channels: { fetch: ReturnType<typeof vi.fn> };
    rest: EventEmitter;
  };
}

/**
 * Create a mock text channel
 */
function createMockChannel(): TextChannel {
  return {
    id: 'channel-123',
    type: ChannelType.GuildText,
    isTextBased: () => true,
    send: vi.fn().mockResolvedValue({ id: 'sent-msg-id' }),
  } as unknown as TextChannel;
}

/**
 * Create a mock Discord message
 */
function createMockMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-123',
    content: 'Test message',
    author: {
      id: 'user-456',
      bot: false,
      displayName: 'TestUser',
    },
    member: { displayName: 'TestMember' },
    createdAt: new Date(),
    channelId: 'channel-789',
    guild: { id: 'guild-111', name: 'Test Guild' },
    channel: {
      isThread: () => false,
      isDMBased: () => false,
    },
    embeds: [],
    reference: null,
    attachments: { size: 0, map: () => [] },
    partial: false,
    ...overrides,
  } as unknown as Message;
}

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).__mockClientRef = null;
    adapter = new DiscordAdapter({ token: 'test-token' });
  });

  afterEach(() => {
    vi.clearAllMocks();
    (globalThis as Record<string, unknown>).__mockClientRef = null;
  });

  describe('constructor', () => {
    it('should validate config on construction', () => {
      expect(() => new DiscordAdapter({ token: '' })).toThrow('Discord token is required');
    });

    it('should set platform to "discord"', () => {
      expect(adapter.platform).toBe('discord');
    });
  });

  describe('start()', () => {
    it('should login and wait for ready event', async () => {
      const startPromise = adapter.start();

      // Simulate ready event
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });

      await startPromise;

      expect(getMockClient()?.login).toHaveBeenCalledWith('test-token');
    });

    it('should throw DiscordConnectionError on login failure', async () => {
      const client = getMockClient();
      client.login = vi.fn().mockRejectedValue(new Error('Invalid token'));

      await expect(adapter.start()).rejects.toThrow(DiscordConnectionError);
    });

    it('should be idempotent (multiple starts do nothing)', async () => {
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;

      // Second start should do nothing
      await adapter.start();

      expect(getMockClient()?.login).toHaveBeenCalledTimes(1);
    });
  });

  describe('stop()', () => {
    it('should destroy client', async () => {
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;

      await adapter.stop();

      expect(getMockClient()?.destroy).toHaveBeenCalled();
    });

    it('should be idempotent', async () => {
      await adapter.stop();
      await adapter.stop();

      expect(getMockClient()?.destroy).not.toHaveBeenCalled();
    });
  });

  describe('onMessage()', () => {
    it('should register message handler', async () => {
      const handler = vi.fn();
      adapter.onMessage(handler);

      // Start adapter
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;

      // Simulate incoming message
      const message = createMockMessage();
      getMockClient()?.emit(Events.MessageCreate, message);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).toHaveBeenCalled();
    });

    // AC-5: Bot self-filtering
    it('should not invoke handler for bot own messages', async () => {
      const handler = vi.fn();
      adapter.onMessage(handler);

      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;

      // Message from bot itself
      const message = createMockMessage({
        author: {
          id: 'bot-user-id', // Same as mockClient.user.id
          bot: true,
          displayName: 'Bot',
        } as Message['author'],
      });
      getMockClient()?.emit(Events.MessageCreate, message);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // AC-2: sendMessage returns message ID
  describe('sendMessage()', () => {
    beforeEach(async () => {
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;
    });

    it('should return message ID', async () => {
      const channel = createMockChannel();
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      const messageId = await adapter.sendMessage('channel-123', 'Hello');

      expect(messageId).toBe('sent-msg-id');
    });

    it('should send message to correct channel', async () => {
      const channel = createMockChannel();
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      await adapter.sendMessage('channel-123', 'Hello, world!');

      expect(channel.send).toHaveBeenCalledWith({
        content: 'Hello, world!',
      });
    });

    it('should handle reply option', async () => {
      const channel = createMockChannel();
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      await adapter.sendMessage('channel-123', 'Reply message', {
        replyTo: 'original-msg-id',
      });

      expect(channel.send).toHaveBeenCalledWith({
        content: 'Reply message',
        reply: { messageReference: 'original-msg-id' },
      });
    });

    // AC-3: Message splitting
    it('should split long messages', async () => {
      const channel = createMockChannel();
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      const longMessage = 'a'.repeat(2500);
      await adapter.sendMessage('channel-123', longMessage);

      // Should have sent multiple messages
      expect(channel.send).toHaveBeenCalledTimes(2);
    });

    it('should throw DiscordChannelNotFoundError for unknown channel', async () => {
      // Create a mock error that looks like DiscordAPIError
      const error = Object.assign(new Error('Unknown Channel'), {
        code: 10003,
        status: 404,
      });
      Object.setPrototypeOf(error, DiscordAPIError.prototype);
      getMockClient().channels.fetch = vi.fn().mockRejectedValue(error);

      await expect(adapter.sendMessage('unknown-channel', 'Hello')).rejects.toThrow(
        DiscordChannelNotFoundError
      );
    });

    it('should throw DiscordPermissionError for missing access', async () => {
      const error = Object.assign(new Error('Missing Access'), {
        code: 50001,
        status: 403,
      });
      Object.setPrototypeOf(error, DiscordAPIError.prototype);
      getMockClient().channels.fetch = vi.fn().mockRejectedValue(error);

      await expect(adapter.sendMessage('private-channel', 'Hello')).rejects.toThrow(
        DiscordPermissionError
      );
    });

    it('should throw DiscordPermissionError for missing permissions', async () => {
      const error = Object.assign(new Error('Missing Permissions'), {
        code: 50013,
        status: 403,
      });
      Object.setPrototypeOf(error, DiscordAPIError.prototype);
      const channel = createMockChannel();
      channel.send = vi.fn().mockRejectedValue(error);
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      await expect(adapter.sendMessage('channel-123', 'Hello')).rejects.toThrow(
        DiscordPermissionError
      );
    });

    it('should throw DiscordSendError for empty message', async () => {
      const channel = createMockChannel();
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      await expect(adapter.sendMessage('channel-123', '')).rejects.toThrow(DiscordSendError);
    });
  });

  // AC: @discord-channel-adapter ac-5
  describe('editMessage()', () => {
    beforeEach(async () => {
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;
    });

    it('should edit message and return ID when under limit', async () => {
      const mockMessage = {
        id: 'msg-123',
        edit: vi.fn().mockResolvedValue({ id: 'msg-123' }),
      };
      const channel = {
        ...createMockChannel(),
        messages: { fetch: vi.fn().mockResolvedValue(mockMessage) },
      };
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      const result = await adapter.editMessage('channel-123', 'msg-123', 'Short message');

      expect(mockMessage.edit).toHaveBeenCalledWith('Short message');
      expect(result).toBe('msg-123');
    });

    it('should split long messages and return overflow IDs', async () => {
      const mockMessage = {
        id: 'msg-123',
        edit: vi.fn().mockResolvedValue({ id: 'msg-123' }),
      };
      const channel = {
        ...createMockChannel(),
        messages: { fetch: vi.fn().mockResolvedValue(mockMessage) },
        send: vi
          .fn()
          .mockResolvedValueOnce({ id: 'overflow-1' })
          .mockResolvedValueOnce({ id: 'overflow-2' }),
      };
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      const longMessage = 'a'.repeat(2500); // Will split into 2 chunks
      const result = await adapter.editMessage('channel-123', 'msg-123', longMessage);

      // Should have edited original and sent overflow
      expect(mockMessage.edit).toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalled();

      // Should return EditMessageResult
      expect(result).toEqual({
        editedId: 'msg-123',
        overflowIds: expect.arrayContaining([expect.any(String)]),
      });
    });

    it('should not split messages exactly at limit', async () => {
      const mockMessage = {
        id: 'msg-123',
        edit: vi.fn().mockResolvedValue({ id: 'msg-123' }),
      };
      const channel = {
        ...createMockChannel(),
        messages: { fetch: vi.fn().mockResolvedValue(mockMessage) },
      };
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      const exactMessage = 'a'.repeat(2000); // Exactly at limit
      const result = await adapter.editMessage('channel-123', 'msg-123', exactMessage);

      expect(mockMessage.edit).toHaveBeenCalledWith(exactMessage);
      expect(result).toBe('msg-123');
    });

    it('should throw DiscordSendError for message not found', async () => {
      const error = Object.assign(new Error('Unknown Message'), {
        code: 10008,
        status: 404,
      });
      Object.setPrototypeOf(error, DiscordAPIError.prototype);
      const channel = {
        ...createMockChannel(),
        messages: { fetch: vi.fn().mockRejectedValue(error) },
      };
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      await expect(adapter.editMessage('channel-123', 'unknown-msg', 'Hello')).rejects.toThrow(
        DiscordSendError
      );
    });

    it('should throw DiscordPermissionError when cannot edit others message', async () => {
      const error = Object.assign(new Error('Cannot edit message'), {
        code: 50005,
        status: 403,
      });
      Object.setPrototypeOf(error, DiscordAPIError.prototype);
      const mockMessage = {
        id: 'msg-123',
        edit: vi.fn().mockRejectedValue(error),
      };
      const channel = {
        ...createMockChannel(),
        messages: { fetch: vi.fn().mockResolvedValue(mockMessage) },
      };
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      await expect(adapter.editMessage('channel-123', 'msg-123', 'Hello')).rejects.toThrow(
        DiscordPermissionError
      );
    });
  });

  describe('sendTyping()', () => {
    beforeEach(async () => {
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;
    });

    it('should call sendTyping on the channel', async () => {
      const sendTyping = vi.fn().mockResolvedValue(undefined);
      const channel = {
        ...createMockChannel(),
        sendTyping,
      };
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      await adapter.sendTyping('channel-123');

      expect(sendTyping).toHaveBeenCalled();
    });

    it('should not throw on typing indicator failure', async () => {
      const channel = {
        ...createMockChannel(),
        sendTyping: vi.fn().mockRejectedValue(new Error('Rate limited')),
      };
      getMockClient().channels.fetch = vi.fn().mockResolvedValue(channel);

      // Should not throw
      await expect(adapter.sendTyping('channel-123')).resolves.not.toThrow();
    });
  });

  // AC-4: Reconnection logging
  describe('connection events', () => {
    it('should log shard reconnecting events', async () => {
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;

      // Emit reconnecting event (should not throw)
      getMockClient()?.emit(Events.ShardReconnecting, 0);
    });

    it('should log shard resume events', async () => {
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;

      // Emit resume event (should not throw)
      getMockClient()?.emit(Events.ShardResume, 0, 5);
    });

    it('should log shard disconnect events', async () => {
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;

      // Emit disconnect event (should not throw)
      getMockClient()?.emit(Events.ShardDisconnect, { code: 4000 }, 0);
    });

    it('should log client errors', async () => {
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;

      // Emit error event (should not throw)
      getMockClient()?.emit(Events.Error, new Error('Test error'));
    });

    it('should log rate limit events from REST client', async () => {
      const startPromise = adapter.start();
      setImmediate(() => {
        const client = getMockClient();
        client?.emit(Events.ClientReady, client);
      });
      await startPromise;

      // Emit rate limit event on the REST client (should not throw)
      getMockClient()?.rest.emit('rateLimited', {
        route: '/channels/123/messages',
        method: 'POST',
        limit: 5,
        retryAfter: 1000,
        global: false,
      });
    });
  });
});

describe('Discord error types', () => {
  it('DiscordConnectionError should have correct code', () => {
    const error = new DiscordConnectionError('Connection failed');
    expect(error.code).toBe('DISCORD_CONNECTION_ERROR');
    expect(error.message).toBe('Connection failed');
  });

  it('DiscordChannelNotFoundError should include channel ID', () => {
    const error = new DiscordChannelNotFoundError('channel-123');
    expect(error.code).toBe('DISCORD_CHANNEL_NOT_FOUND');
    expect(error.message).toContain('channel-123');
    expect(error.context?.channelId).toBe('channel-123');
  });

  it('DiscordPermissionError should have correct code', () => {
    const error = new DiscordPermissionError('Missing permissions');
    expect(error.code).toBe('DISCORD_PERMISSION_ERROR');
  });

  it('DiscordSendError should have correct code', () => {
    const error = new DiscordSendError('Failed to send');
    expect(error.code).toBe('DISCORD_SEND_ERROR');
  });
});
