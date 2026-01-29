/**
 * Discord Message Parser Tests
 *
 * Test coverage for message parsing (AC-1, AC-5, AC-6, AC-7).
 */

import { describe, it, expect, vi } from 'vitest';
import { parseIncoming, parseAttachments } from '../../../src/adapters/discord/parser.js';
import type { Message, Collection, Attachment as DiscordAttachment } from 'discord.js';

/**
 * Create a mock Discord message
 */
function createMockMessage(overrides: Partial<Message> = {}): Message {
  const baseMessage = {
    id: 'msg-123',
    content: 'Test message content',
    author: {
      id: 'user-456',
      bot: false,
      displayName: 'TestUser',
    },
    member: {
      displayName: 'TestMember',
    },
    createdAt: new Date('2024-01-01T12:00:00Z'),
    channelId: 'channel-789',
    guild: {
      id: 'guild-111',
      name: 'Test Guild',
    },
    channel: {
      isThread: () => false,
      isDMBased: () => false,
      parentId: null,
    },
    embeds: [],
    reference: null,
    attachments: createMockAttachmentCollection([]),
    partial: false,
    fetch: vi.fn(),
    ...overrides,
  } as unknown as Message;

  return baseMessage;
}

/**
 * Create a mock attachment collection
 */
function createMockAttachmentCollection(
  attachments: Partial<DiscordAttachment>[],
): Collection<string, DiscordAttachment> {
  const map = new Map<string, DiscordAttachment>();
  attachments.forEach((a, i) => {
    const attachment = {
      id: `attachment-${i}`,
      url: `https://cdn.discord.com/attachment-${i}`,
      proxyURL: `https://media.discord.com/attachment-${i}`,
      contentType: 'image/png',
      name: `image-${i}.png`,
      size: 1024,
      width: 100,
      height: 100,
      ...a,
    } as DiscordAttachment;
    map.set(attachment.id, attachment);
  });

  return {
    map: (fn: (value: DiscordAttachment) => unknown) =>
      Array.from(map.values()).map(fn),
    size: map.size,
  } as unknown as Collection<string, DiscordAttachment>;
}

describe('parseIncoming (@discord-channel-adapter)', () => {
  const botUserId = 'bot-user-id';

  // AC-1: parseIncoming converts Discord.Message to NormalizedMessage
  describe('AC-1: message normalization', () => {
    it('should convert Discord message to NormalizedMessage with platform="discord"', async () => {
      const message = createMockMessage();
      const normalized = await parseIncoming(message, botUserId);

      expect(normalized).not.toBeNull();
      expect(normalized!.sender.platform).toBe('discord');
    });

    it('should extract message ID', async () => {
      const message = createMockMessage({ id: 'unique-msg-id' });
      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.id).toBe('unique-msg-id');
    });

    it('should extract message content', async () => {
      const message = createMockMessage({ content: 'Hello, world!' });
      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.text).toBe('Hello, world!');
    });

    it('should extract channel ID', async () => {
      const message = createMockMessage({ channelId: 'my-channel' });
      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.channel).toBe('my-channel');
    });

    it('should extract author information', async () => {
      const message = createMockMessage({
        author: {
          id: 'author-id',
          bot: false,
          displayName: 'AuthorName',
        } as Message['author'],
      });
      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.sender.id).toBe('author-id');
      expect(normalized!.sender.platform).toBe('discord');
    });

    it('should prefer member displayName over author displayName', async () => {
      const message = createMockMessage({
        author: {
          id: 'author-id',
          bot: false,
          displayName: 'AuthorGlobalName',
        } as Message['author'],
        member: {
          displayName: 'ServerNickname',
        } as Message['member'],
      });
      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.sender.displayName).toBe('ServerNickname');
    });

    it('should extract timestamp', async () => {
      const timestamp = new Date('2024-06-15T10:30:00Z');
      const message = createMockMessage({ createdAt: timestamp });
      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.timestamp).toEqual(timestamp);
    });

    it('should include guild info in metadata', async () => {
      const message = createMockMessage({
        guild: {
          id: 'guild-id',
          name: 'My Server',
        } as Message['guild'],
      });
      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.metadata.guildId).toBe('guild-id');
      expect(normalized!.metadata.guildName).toBe('My Server');
    });
  });

  // AC-5: Bot self-message filtering
  describe('AC-5: bot self-filtering', () => {
    it('should return null for bot own messages', async () => {
      const message = createMockMessage({
        author: {
          id: botUserId, // Same as bot user ID
          bot: true,
          displayName: 'Bot',
        } as Message['author'],
      });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized).toBeNull();
    });

    it('should filter out messages from other bots', async () => {
      const message = createMockMessage({
        author: {
          id: 'other-bot-id',
          bot: true,
          displayName: 'OtherBot',
        } as Message['author'],
      });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized).toBeNull();
    });

    it('should not filter human messages', async () => {
      const message = createMockMessage({
        author: {
          id: 'human-user-id',
          bot: false,
          displayName: 'Human',
        } as Message['author'],
      });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized).not.toBeNull();
    });
  });

  // AC-6: Thread handling
  describe('AC-6: thread handling', () => {
    it('should set isThread=true for thread messages', async () => {
      const message = createMockMessage({
        channel: {
          isThread: () => true,
          isDMBased: () => false,
          parentId: 'parent-channel-id',
        } as unknown as Message['channel'],
      });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.metadata.isThread).toBe(true);
    });

    it('should include parentChannelId for thread messages', async () => {
      const message = createMockMessage({
        channel: {
          isThread: () => true,
          isDMBased: () => false,
          parentId: 'parent-channel-123',
        } as unknown as Message['channel'],
      });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.metadata.parentChannelId).toBe('parent-channel-123');
    });

    it('should not set isThread for non-thread channels', async () => {
      const message = createMockMessage({
        channel: {
          isThread: () => false,
          isDMBased: () => false,
          parentId: null,
        } as unknown as Message['channel'],
      });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.metadata.isThread).toBeUndefined();
    });
  });

  // AC-7: DM handling
  describe('AC-7: DM handling', () => {
    it('should set isDM=true for DM messages', async () => {
      const message = createMockMessage({
        guild: null,
        channel: {
          isThread: () => false,
          isDMBased: () => true,
          parentId: null,
        } as unknown as Message['channel'],
      });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.metadata.isDM).toBe(true);
    });

    it('should not set isDM for guild messages', async () => {
      const message = createMockMessage({
        channel: {
          isThread: () => false,
          isDMBased: () => false,
          parentId: null,
        } as unknown as Message['channel'],
      });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.metadata.isDM).toBeUndefined();
    });
  });

  describe('embed handling', () => {
    it('should include embeds in metadata', async () => {
      const embed = { title: 'Test Embed', description: 'Embed content' };
      const message = createMockMessage({
        embeds: [{ toJSON: () => embed }] as Message['embeds'],
      });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.metadata.embeds).toHaveLength(1);
      expect(normalized!.metadata.embeds![0]).toEqual(embed);
    });

    it('should not include embeds key when no embeds', async () => {
      const message = createMockMessage({ embeds: [] });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.metadata.embeds).toBeUndefined();
    });
  });

  describe('reply reference handling', () => {
    it('should include referencedMessageId for replies', async () => {
      const message = createMockMessage({
        reference: {
          messageId: 'referenced-msg-id',
        } as Message['reference'],
      });

      const normalized = await parseIncoming(message, botUserId);

      expect(normalized!.metadata.referencedMessageId).toBe('referenced-msg-id');
    });
  });

  describe('partial message handling', () => {
    it('should fetch partial messages', async () => {
      const fullMessage = createMockMessage({ content: 'Full content' });
      const partialMessage = createMockMessage({
        partial: true,
        content: '',
        fetch: vi.fn().mockResolvedValue(fullMessage),
      });

      const normalized = await parseIncoming(partialMessage, botUserId);

      expect(partialMessage.fetch).toHaveBeenCalled();
      expect(normalized!.text).toBe('Full content');
    });

    it('should return null if partial fetch fails', async () => {
      const partialMessage = createMockMessage({
        partial: true,
        content: '',
        fetch: vi.fn().mockRejectedValue(new Error('Fetch failed')),
      });

      const normalized = await parseIncoming(partialMessage, botUserId);

      expect(normalized).toBeNull();
    });
  });
});

describe('parseAttachments', () => {
  it('should parse image attachments', () => {
    const attachments = createMockAttachmentCollection([
      {
        url: 'https://cdn.discord.com/image.png',
        contentType: 'image/png',
        name: 'image.png',
        size: 2048,
      },
    ]);

    const parsed = parseAttachments(attachments);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('image');
    expect(parsed[0].url).toBe('https://cdn.discord.com/image.png');
    expect(parsed[0].mimeType).toBe('image/png');
    expect(parsed[0].filename).toBe('image.png');
    expect(parsed[0].size).toBe(2048);
  });

  it('should parse video attachments', () => {
    const attachments = createMockAttachmentCollection([
      {
        url: 'https://cdn.discord.com/video.mp4',
        contentType: 'video/mp4',
        name: 'video.mp4',
        size: 10240,
      },
    ]);

    const parsed = parseAttachments(attachments);

    expect(parsed[0].type).toBe('video');
  });

  it('should parse audio attachments', () => {
    const attachments = createMockAttachmentCollection([
      {
        url: 'https://cdn.discord.com/audio.mp3',
        contentType: 'audio/mpeg',
        name: 'audio.mp3',
        size: 5120,
      },
    ]);

    const parsed = parseAttachments(attachments);

    expect(parsed[0].type).toBe('audio');
  });

  it('should default to file type for unknown content types', () => {
    const attachments = createMockAttachmentCollection([
      {
        url: 'https://cdn.discord.com/document.pdf',
        contentType: 'application/pdf',
        name: 'document.pdf',
        size: 1024,
      },
    ]);

    const parsed = parseAttachments(attachments);

    expect(parsed[0].type).toBe('file');
  });

  it('should handle null content type', () => {
    const attachments = createMockAttachmentCollection([
      {
        url: 'https://cdn.discord.com/unknown',
        contentType: null,
        name: 'unknown',
        size: 512,
      },
    ]);

    const parsed = parseAttachments(attachments);

    expect(parsed[0].type).toBe('file');
    expect(parsed[0].mimeType).toBeUndefined();
  });

  it('should include metadata for images', () => {
    const attachments = createMockAttachmentCollection([
      {
        url: 'https://cdn.discord.com/image.png',
        proxyURL: 'https://media.discord.com/image.png',
        contentType: 'image/png',
        width: 800,
        height: 600,
      },
    ]);

    const parsed = parseAttachments(attachments);

    expect(parsed[0].metadata).toEqual({
      proxyUrl: 'https://media.discord.com/image.png',
      width: 800,
      height: 600,
    });
  });

  it('should parse multiple attachments', () => {
    const attachments = createMockAttachmentCollection([
      { contentType: 'image/png' },
      { contentType: 'video/mp4' },
      { contentType: 'audio/mpeg' },
    ]);

    const parsed = parseAttachments(attachments);

    expect(parsed).toHaveLength(3);
    expect(parsed[0].type).toBe('image');
    expect(parsed[1].type).toBe('video');
    expect(parsed[2].type).toBe('audio');
  });
});
