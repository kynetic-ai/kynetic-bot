/**
 * ChannelRegistry Tests
 *
 * Test coverage for channel adapter registration and management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ChannelRegistry } from '../src/registry.js';
import { ValidationError } from '../src/types.js';
import type { ChannelAdapter, NormalizedMessage } from '@kynetic-bot/core';

/**
 * Create a mock channel adapter
 */
function createMockAdapter(overrides?: Partial<ChannelAdapter>): ChannelAdapter {
  return {
    platform: 'test-platform',
    start: async () => {},
    stop: async () => {},
    sendMessage: async () => {},
    onMessage: () => {},
    ...overrides,
  };
}

describe('ChannelRegistry', () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry();
  });

  describe('Channel Registration (@channel-registry)', () => {
    // AC: @channel-registry ac-1
    it('should validate adapter interface and add to registry', () => {
      const adapter = createMockAdapter({ platform: 'whatsapp' });

      const result = registry.register(adapter);

      expect(result.ok).toBe(true);
      expect(registry.hasAdapter('whatsapp')).toBe(true);
      expect(registry.getAdapter('whatsapp')).toBe(adapter);
    });

    // AC: @channel-registry ac-2
    it('should return correct adapter for the platform', () => {
      const whatsappAdapter = createMockAdapter({ platform: 'whatsapp' });
      const telegramAdapter = createMockAdapter({ platform: 'telegram' });

      registry.register(whatsappAdapter);
      registry.register(telegramAdapter);

      const retrieved = registry.getAdapter('whatsapp');
      expect(retrieved).toBe(whatsappAdapter);
      expect(retrieved?.platform).toBe('whatsapp');
    });

    // AC: @channel-registry ac-3
    it('should return validation error listing missing methods', () => {
      const invalidAdapter = {
        platform: 'invalid',
        start: async () => {},
        // Missing: stop, sendMessage, onMessage
      };

      const result = registry.register(invalidAdapter as ChannelAdapter);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.code).toBe('VALIDATION_ERROR');
        expect(result.error.missingMethods).toContain('stop');
        expect(result.error.missingMethods).toContain('sendMessage');
        expect(result.error.missingMethods).toContain('onMessage');
        expect(result.error.message).toContain('stop');
        expect(result.error.message).toContain('sendMessage');
        expect(result.error.message).toContain('onMessage');
      }
    });
  });

  describe('Adapter Validation', () => {
    it('should reject non-object adapters', () => {
      const result = registry.register(null as unknown as ChannelAdapter);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.message).toContain('must be an object');
      }
    });

    it('should reject adapter without platform property', () => {
      const adapter = {
        start: async () => {},
        stop: async () => {},
        sendMessage: async () => {},
        onMessage: () => {},
      };

      const result = registry.register(adapter as ChannelAdapter);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.missingMethods).toContain('platform');
      }
    });

    it('should reject adapter with non-string platform', () => {
      const adapter = {
        platform: 123, // Wrong type
        start: async () => {},
        stop: async () => {},
        sendMessage: async () => {},
        onMessage: () => {},
      };

      const result = registry.register(adapter as unknown as ChannelAdapter);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.missingMethods).toContain('platform');
      }
    });

    it('should reject adapter with non-function methods', () => {
      const adapter = {
        platform: 'test',
        start: 'not a function',
        stop: async () => {},
        sendMessage: async () => {},
        onMessage: () => {},
      };

      const result = registry.register(adapter as unknown as ChannelAdapter);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.missingMethods).toContain('start');
      }
    });

    it('should accept adapter with all required methods', () => {
      const adapter = createMockAdapter({
        platform: 'complete-adapter',
      });

      const result = registry.register(adapter);

      expect(result.ok).toBe(true);
      expect(registry.hasAdapter('complete-adapter')).toBe(true);
    });
  });

  describe('Adapter Management', () => {
    it('should list all registered adapters', () => {
      const adapter1 = createMockAdapter({ platform: 'platform1' });
      const adapter2 = createMockAdapter({ platform: 'platform2' });
      const adapter3 = createMockAdapter({ platform: 'platform3' });

      registry.register(adapter1);
      registry.register(adapter2);
      registry.register(adapter3);

      const adapters = registry.listAdapters();
      expect(adapters).toHaveLength(3);
      expect(adapters).toContain(adapter1);
      expect(adapters).toContain(adapter2);
      expect(adapters).toContain(adapter3);
    });

    it('should return undefined for unregistered platform', () => {
      const adapter = registry.getAdapter('nonexistent');
      expect(adapter).toBeUndefined();
    });

    it('should unregister adapter by platform', () => {
      const adapter = createMockAdapter({ platform: 'whatsapp' });

      registry.register(adapter);
      expect(registry.hasAdapter('whatsapp')).toBe(true);

      const removed = registry.unregister('whatsapp');
      expect(removed).toBe(true);
      expect(registry.hasAdapter('whatsapp')).toBe(false);
    });

    it('should return false when unregistering non-existent platform', () => {
      const removed = registry.unregister('nonexistent');
      expect(removed).toBe(false);
    });

    it('should clear all adapters', () => {
      registry.register(createMockAdapter({ platform: 'platform1' }));
      registry.register(createMockAdapter({ platform: 'platform2' }));

      expect(registry.listAdapters()).toHaveLength(2);

      registry.clear();

      expect(registry.listAdapters()).toHaveLength(0);
      expect(registry.hasAdapter('platform1')).toBe(false);
      expect(registry.hasAdapter('platform2')).toBe(false);
    });

    it('should replace adapter when registering same platform twice', () => {
      const adapter1 = createMockAdapter({ platform: 'whatsapp' });
      const adapter2 = createMockAdapter({ platform: 'whatsapp' });

      registry.register(adapter1);
      expect(registry.getAdapter('whatsapp')).toBe(adapter1);

      registry.register(adapter2);
      expect(registry.getAdapter('whatsapp')).toBe(adapter2);
      expect(registry.listAdapters()).toHaveLength(1);
    });
  });

  describe('Multiple Platforms', () => {
    it('should handle multiple different platforms independently', () => {
      const whatsapp = createMockAdapter({ platform: 'whatsapp' });
      const telegram = createMockAdapter({ platform: 'telegram' });
      const discord = createMockAdapter({ platform: 'discord' });

      registry.register(whatsapp);
      registry.register(telegram);
      registry.register(discord);

      expect(registry.getAdapter('whatsapp')).toBe(whatsapp);
      expect(registry.getAdapter('telegram')).toBe(telegram);
      expect(registry.getAdapter('discord')).toBe(discord);

      // Unregister one shouldn't affect others
      registry.unregister('telegram');

      expect(registry.hasAdapter('telegram')).toBe(false);
      expect(registry.hasAdapter('whatsapp')).toBe(true);
      expect(registry.hasAdapter('discord')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty registry', () => {
      expect(registry.listAdapters()).toHaveLength(0);
      expect(registry.getAdapter('any')).toBeUndefined();
      expect(registry.hasAdapter('any')).toBe(false);
    });

    it('should validate all missing methods are listed in error', () => {
      const adapter = {
        platform: 'incomplete',
      };

      const result = registry.register(adapter as unknown as ChannelAdapter);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.missingMethods).toContain('start');
        expect(result.error.missingMethods).toContain('stop');
        expect(result.error.missingMethods).toContain('sendMessage');
        expect(result.error.missingMethods).toContain('onMessage');
        expect(result.error.missingMethods).toHaveLength(4);
      }
    });

    it('should handle platform name case sensitivity', () => {
      const adapter = createMockAdapter({ platform: 'WhatsApp' });

      registry.register(adapter);

      expect(registry.hasAdapter('WhatsApp')).toBe(true);
      expect(registry.hasAdapter('whatsapp')).toBe(false); // Case sensitive
    });
  });
});
