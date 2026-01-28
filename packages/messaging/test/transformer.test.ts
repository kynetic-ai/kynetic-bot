/**
 * MessageTransformer Tests
 *
 * Test coverage for message transformation and platform normalization.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MessageTransformer,
  type PlatformTransformer,
  UnsupportedTypeError,
  MissingTransformerError,
  type Result,
} from '../src/transformer.js';
import type { NormalizedMessage } from '@kynetic-bot/core';
import { KyneticError } from '@kynetic-bot/core';

/**
 * Mock platform-specific message format for WhatsApp
 */
interface WhatsAppMessage {
  from: string;
  body: string;
  timestamp: number;
  type: string;
}

/**
 * Mock WhatsApp transformer
 */
class MockWhatsAppTransformer implements PlatformTransformer {
  platform = 'whatsapp';

  normalize(raw: unknown): Result<NormalizedMessage, KyneticError> {
    if (typeof raw !== 'object' || raw === null) {
      return {
        ok: false,
        error: new KyneticError('Invalid message format', 'INVALID_FORMAT'),
      };
    }

    const msg = raw as WhatsAppMessage;

    // AC-3: Check for unsupported content type
    if (msg.type && msg.type !== 'text') {
      return {
        ok: false,
        error: new UnsupportedTypeError(msg.type, 'whatsapp'),
      };
    }

    // AC-1: Produce normalized message with standard fields
    return {
      ok: true,
      value: {
        id: `wa-${msg.timestamp}`,
        text: msg.body,
        sender: {
          id: msg.from,
          platform: 'whatsapp',
        },
        timestamp: new Date(msg.timestamp),
        channel: msg.from,
        metadata: { raw },
      },
    };
  }

  denormalize(message: NormalizedMessage): Result<unknown, KyneticError> {
    // AC-2: Convert normalized message to platform-specific format
    return {
      ok: true,
      value: {
        from: 'bot',
        body: message.text,
        timestamp: message.timestamp.getTime(),
        type: 'text',
      } as WhatsAppMessage,
    };
  }
}

/**
 * Mock Telegram transformer
 */
class MockTelegramTransformer implements PlatformTransformer {
  platform = 'telegram';

  normalize(raw: unknown): Result<NormalizedMessage, KyneticError> {
    if (typeof raw !== 'object' || raw === null) {
      return {
        ok: false,
        error: new KyneticError('Invalid message format', 'INVALID_FORMAT'),
      };
    }

    const msg = raw as { message_id: number; text: string; from: { id: number }; date: number };

    return {
      ok: true,
      value: {
        id: `tg-${msg.message_id}`,
        text: msg.text,
        sender: {
          id: String(msg.from.id),
          platform: 'telegram',
        },
        timestamp: new Date(msg.date * 1000),
        channel: String(msg.from.id),
        metadata: { raw },
      },
    };
  }

  denormalize(message: NormalizedMessage): Result<unknown, KyneticError> {
    return {
      ok: true,
      value: {
        text: message.text,
        chat_id: message.sender.id,
      },
    };
  }
}

describe('MessageTransformer', () => {
  let transformer: MessageTransformer;

  beforeEach(() => {
    transformer = new MessageTransformer();
  });

  describe('Message Transformation (@msg-transform)', () => {
    // AC: @msg-transform ac-1
    it('should produce normalized message with standard fields from platform format', () => {
      const whatsappTransformer = new MockWhatsAppTransformer();
      transformer.registerTransformer(whatsappTransformer);

      const rawMessage: WhatsAppMessage = {
        from: '+1234567890',
        body: 'Hello from WhatsApp',
        timestamp: Date.now(),
        type: 'text',
      };

      const result = transformer.normalize('whatsapp', rawMessage);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.text).toBe('Hello from WhatsApp');
        expect(result.value.sender.id).toBe('+1234567890');
        expect(result.value.sender.platform).toBe('whatsapp');
        expect(result.value.timestamp).toBeInstanceOf(Date);
        expect(result.value.metadata.raw).toBe(rawMessage);
      }
    });

    // AC: @msg-transform ac-2
    it('should convert normalized message to platform-specific format', () => {
      const whatsappTransformer = new MockWhatsAppTransformer();
      transformer.registerTransformer(whatsappTransformer);

      const normalizedMessage: NormalizedMessage = {
        id: 'msg-123',
        text: 'Reply message',
        sender: {
          id: 'bot',
          platform: 'whatsapp',
        },
        timestamp: new Date(),
        channel: 'channel-1',
        metadata: {},
      };

      const result = transformer.denormalize('whatsapp', normalizedMessage);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const wa = result.value as WhatsAppMessage;
        expect(wa.body).toBe('Reply message');
        expect(wa.type).toBe('text');
      }
    });

    // AC: @msg-transform ac-3
    it('should return error indicating unsupported type', () => {
      const whatsappTransformer = new MockWhatsAppTransformer();
      transformer.registerTransformer(whatsappTransformer);

      const rawMessage: WhatsAppMessage = {
        from: '+1234567890',
        body: '',
        timestamp: Date.now(),
        type: 'video', // Unsupported type
      };

      const result = transformer.normalize('whatsapp', rawMessage);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(UnsupportedTypeError);
        expect(result.error.code).toBe('UNSUPPORTED_TYPE');
        expect(result.error.context?.contentType).toBe('video');
        expect(result.error.message).toContain('video');
      }
    });
  });

  describe('Transformer Registration', () => {
    it('should register and retrieve transformers', () => {
      const whatsappTransformer = new MockWhatsAppTransformer();
      const telegramTransformer = new MockTelegramTransformer();

      expect(transformer.hasTransformer('whatsapp')).toBe(false);
      expect(transformer.hasTransformer('telegram')).toBe(false);

      transformer.registerTransformer(whatsappTransformer);
      transformer.registerTransformer(telegramTransformer);

      expect(transformer.hasTransformer('whatsapp')).toBe(true);
      expect(transformer.hasTransformer('telegram')).toBe(true);
    });

    it('should list registered platforms', () => {
      const whatsappTransformer = new MockWhatsAppTransformer();
      const telegramTransformer = new MockTelegramTransformer();

      transformer.registerTransformer(whatsappTransformer);
      transformer.registerTransformer(telegramTransformer);

      const platforms = transformer.listPlatforms();
      expect(platforms).toHaveLength(2);
      expect(platforms).toContain('whatsapp');
      expect(platforms).toContain('telegram');
    });

    it('should unregister transformers', () => {
      const whatsappTransformer = new MockWhatsAppTransformer();
      transformer.registerTransformer(whatsappTransformer);

      expect(transformer.hasTransformer('whatsapp')).toBe(true);

      const removed = transformer.unregisterTransformer('whatsapp');
      expect(removed).toBe(true);
      expect(transformer.hasTransformer('whatsapp')).toBe(false);
    });

    it('should return false when unregistering non-existent platform', () => {
      const removed = transformer.unregisterTransformer('nonexistent');
      expect(removed).toBe(false);
    });

    it('should clear all transformers', () => {
      transformer.registerTransformer(new MockWhatsAppTransformer());
      transformer.registerTransformer(new MockTelegramTransformer());

      expect(transformer.listPlatforms()).toHaveLength(2);

      transformer.clear();

      expect(transformer.listPlatforms()).toHaveLength(0);
      expect(transformer.hasTransformer('whatsapp')).toBe(false);
      expect(transformer.hasTransformer('telegram')).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should return MissingTransformerError for unregistered platform during normalize', () => {
      const result = transformer.normalize('unregistered', { some: 'data' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(MissingTransformerError);
        expect(result.error.code).toBe('MISSING_TRANSFORMER');
        expect(result.error.context?.platform).toBe('unregistered');
      }
    });

    it('should return MissingTransformerError for unregistered platform during denormalize', () => {
      const message: NormalizedMessage = {
        id: 'msg-123',
        text: 'Test',
        sender: { id: 'user', platform: 'unknown' },
        timestamp: new Date(),
        channel: 'channel-1',
        metadata: {},
      };

      const result = transformer.denormalize('unregistered', message);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(MissingTransformerError);
        expect(result.error.code).toBe('MISSING_TRANSFORMER');
        expect(result.error.context?.platform).toBe('unregistered');
      }
    });
  });

  describe('Multiple Platforms', () => {
    it('should handle transformations for different platforms independently', () => {
      transformer.registerTransformer(new MockWhatsAppTransformer());
      transformer.registerTransformer(new MockTelegramTransformer());

      const waMessage: WhatsAppMessage = {
        from: '+1234567890',
        body: 'WhatsApp message',
        timestamp: Date.now(),
        type: 'text',
      };

      const tgMessage = {
        message_id: 123,
        text: 'Telegram message',
        from: { id: 987654321 },
        date: Math.floor(Date.now() / 1000),
      };

      const waResult = transformer.normalize('whatsapp', waMessage);
      const tgResult = transformer.normalize('telegram', tgMessage);

      expect(waResult.ok).toBe(true);
      expect(tgResult.ok).toBe(true);

      if (waResult.ok && tgResult.ok) {
        expect(waResult.value.text).toBe('WhatsApp message');
        expect(waResult.value.sender.platform).toBe('whatsapp');

        expect(tgResult.value.text).toBe('Telegram message');
        expect(tgResult.value.sender.platform).toBe('telegram');
      }
    });
  });

  describe('Round-trip Transformation', () => {
    it('should handle round-trip transformation (normalize -> denormalize)', () => {
      transformer.registerTransformer(new MockWhatsAppTransformer());

      const rawMessage: WhatsAppMessage = {
        from: '+1234567890',
        body: 'Original message',
        timestamp: Date.now(),
        type: 'text',
      };

      // Normalize
      const normalizeResult = transformer.normalize('whatsapp', rawMessage);
      expect(normalizeResult.ok).toBe(true);

      if (normalizeResult.ok) {
        // Denormalize
        const denormalizeResult = transformer.denormalize('whatsapp', normalizeResult.value);
        expect(denormalizeResult.ok).toBe(true);

        if (denormalizeResult.ok) {
          const wa = denormalizeResult.value as WhatsAppMessage;
          expect(wa.body).toBe('Original message');
          expect(wa.type).toBe('text');
        }
      }
    });
  });
});
