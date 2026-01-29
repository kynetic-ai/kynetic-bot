/**
 * Discord Adapter Config Tests
 *
 * Test coverage for configuration validation.
 */

import { describe, it, expect } from 'vitest';
import { GatewayIntentBits, Partials } from 'discord.js';
import { DiscordAdapterConfigSchema } from '../../../src/adapters/discord/config.js';

describe('DiscordAdapterConfigSchema', () => {
  describe('token validation', () => {
    it('should require a token', () => {
      expect(() => DiscordAdapterConfigSchema.parse({})).toThrow();
    });

    it('should reject empty token', () => {
      expect(() => DiscordAdapterConfigSchema.parse({ token: '' })).toThrow(
        'Discord token is required',
      );
    });

    it('should accept valid token', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'valid-token-string',
      });
      expect(config.token).toBe('valid-token-string');
    });
  });

  describe('intents validation', () => {
    it('should use default intents when not specified', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'test-token',
      });

      expect(config.intents).toContain(GatewayIntentBits.Guilds);
      expect(config.intents).toContain(GatewayIntentBits.GuildMessages);
      expect(config.intents).toContain(GatewayIntentBits.DirectMessages);
      expect(config.intents).toContain(GatewayIntentBits.MessageContent);
    });

    it('should accept custom intents', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'test-token',
        intents: [GatewayIntentBits.Guilds],
      });

      expect(config.intents).toEqual([GatewayIntentBits.Guilds]);
    });

    it('should reject invalid intent values', () => {
      expect(() =>
        DiscordAdapterConfigSchema.parse({
          token: 'test-token',
          intents: ['invalid-intent'],
        }),
      ).toThrow();
    });
  });

  describe('partials validation', () => {
    it('should use default partials when not specified', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'test-token',
      });

      expect(config.partials).toContain(Partials.Channel);
    });

    it('should accept custom partials', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'test-token',
        partials: [Partials.Message, Partials.Channel],
      });

      expect(config.partials).toContain(Partials.Message);
      expect(config.partials).toContain(Partials.Channel);
    });
  });

  describe('maxMessageLength validation', () => {
    it('should use default maxMessageLength of 2000', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'test-token',
      });

      expect(config.maxMessageLength).toBe(2000);
    });

    it('should accept custom maxMessageLength', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'test-token',
        maxMessageLength: 1500,
      });

      expect(config.maxMessageLength).toBe(1500);
    });

    it('should reject non-positive maxMessageLength', () => {
      expect(() =>
        DiscordAdapterConfigSchema.parse({
          token: 'test-token',
          maxMessageLength: 0,
        }),
      ).toThrow();

      expect(() =>
        DiscordAdapterConfigSchema.parse({
          token: 'test-token',
          maxMessageLength: -1,
        }),
      ).toThrow();
    });
  });

  describe('splitStrategy validation', () => {
    it('should use default splitStrategy of "split"', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'test-token',
      });

      expect(config.splitStrategy).toBe('split');
    });

    it('should accept "split" strategy', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'test-token',
        splitStrategy: 'split',
      });

      expect(config.splitStrategy).toBe('split');
    });

    it('should accept "embed" strategy', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'test-token',
        splitStrategy: 'embed',
      });

      expect(config.splitStrategy).toBe('embed');
    });

    it('should reject invalid splitStrategy', () => {
      expect(() =>
        DiscordAdapterConfigSchema.parse({
          token: 'test-token',
          splitStrategy: 'invalid',
        }),
      ).toThrow();
    });
  });

  describe('full config', () => {
    it('should accept fully specified config', () => {
      const config = DiscordAdapterConfigSchema.parse({
        token: 'my-bot-token',
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
        partials: [Partials.Channel, Partials.Message],
        maxMessageLength: 1800,
        splitStrategy: 'embed',
      });

      expect(config.token).toBe('my-bot-token');
      expect(config.intents).toHaveLength(2);
      expect(config.partials).toHaveLength(2);
      expect(config.maxMessageLength).toBe(1800);
      expect(config.splitStrategy).toBe('embed');
    });
  });
});
