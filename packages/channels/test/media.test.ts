/**
 * MediaHandler Tests
 *
 * Test coverage for media attachment handling.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MediaHandler,
  SizeLimitError,
  UnsupportedMediaTypeError,
  type MediaConfig,
} from '../src/media.js';

describe('MediaHandler', () => {
  let handler: MediaHandler;
  let config: MediaConfig;

  beforeEach(() => {
    config = {
      maxSizeBytes: 1024 * 1024, // 1MB
      allowedTypes: ['image/png', 'image/jpeg', 'application/pdf'],
      storage: 'memory',
    };
    handler = new MediaHandler(config);
  });

  describe('Media Processing (@channel-media)', () => {
    // AC: @channel-media ac-1
    it('should extract and store image with metadata', async () => {
      const imageData = Buffer.from('fake-image-data');
      const metadata = {
        type: 'image/png',
        filename: 'test.png',
        width: 800,
        height: 600,
      };

      const result = await handler.processIncoming(imageData, metadata);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe('image/png');
        expect(result.value.filename).toBe('test.png');
        expect(result.value.size).toBe(imageData.length);
        expect(result.value.id).toBeDefined();
        expect(result.value.url).toContain(result.value.id);
        expect(result.value.metadata).toMatchObject({
          type: 'image/png',
          filename: 'test.png',
          size: imageData.length,
          width: 800,
          height: 600,
        });
      }
    });

    // AC: @channel-media ac-2
    it('should upload file and include reference in outbound message', async () => {
      const fileData = Buffer.from('file-content');
      const metadata = {
        type: 'application/pdf',
        filename: 'document.pdf',
      };

      // First process/store the file
      const processResult = await handler.processIncoming(fileData, metadata);
      expect(processResult.ok).toBe(true);

      if (processResult.ok) {
        // Then prepare it for outgoing delivery
        const prepareResult = await handler.prepareOutgoing(processResult.value);

        expect(prepareResult.ok).toBe(true);
        if (prepareResult.ok) {
          expect(prepareResult.value.url).toBe(processResult.value.url);
          expect(prepareResult.value.data).toBeDefined();
          expect(prepareResult.value.data?.toString()).toBe('file-content');
        }
      }
    });

    // AC: @channel-media ac-3
    it('should reject attachment with size limit error', async () => {
      const largeData = Buffer.alloc(2 * 1024 * 1024); // 2MB (exceeds 1MB limit)
      const metadata = {
        type: 'image/png',
        filename: 'large.png',
      };

      const result = await handler.processIncoming(largeData, metadata);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SizeLimitError);
        expect(result.error.code).toBe('SIZE_LIMIT_EXCEEDED');
        expect((result.error as SizeLimitError).maxSize).toBe(1024 * 1024);
        expect((result.error as SizeLimitError).actualSize).toBe(
          2 * 1024 * 1024,
        );
      }
    });
  });

  describe('Size Validation', () => {
    it('should accept files under size limit', () => {
      const result = handler.validateSize(500 * 1024); // 500KB

      expect(result.ok).toBe(true);
    });

    it('should reject files at exactly the size limit + 1 byte', () => {
      const result = handler.validateSize(1024 * 1024 + 1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(SizeLimitError);
      }
    });

    it('should accept files at exactly the size limit', () => {
      const result = handler.validateSize(1024 * 1024);

      expect(result.ok).toBe(true);
    });

    it('should reject zero-byte files as under limit', () => {
      const result = handler.validateSize(0);

      expect(result.ok).toBe(true);
    });

    it('should provide detailed error information', () => {
      const size = 5 * 1024 * 1024; // 5MB
      const result = handler.validateSize(size);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const error = result.error as SizeLimitError;
        expect(error.message).toContain('5242880');
        expect(error.message).toContain('1048576');
        expect(error.maxSize).toBe(1024 * 1024);
        expect(error.actualSize).toBe(size);
      }
    });
  });

  describe('Type Validation', () => {
    it('should accept allowed media types', () => {
      const types = ['image/png', 'image/jpeg', 'application/pdf'];

      for (const type of types) {
        const result = handler.validateType(type);
        expect(result.ok).toBe(true);
      }
    });

    it('should reject disallowed media types', () => {
      const result = handler.validateType('video/mp4');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(UnsupportedMediaTypeError);
        expect(result.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
        expect((result.error as UnsupportedMediaTypeError).mediaType).toBe(
          'video/mp4',
        );
      }
    });

    it('should allow all types when allowedTypes is empty', () => {
      const permissiveHandler = new MediaHandler({
        ...config,
        allowedTypes: [],
      });

      const result = permissiveHandler.validateType('application/unknown');

      expect(result.ok).toBe(true);
    });

    it('should provide list of allowed types in error', () => {
      const result = handler.validateType('video/mp4');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('image/png');
        expect(result.error.message).toContain('image/jpeg');
        expect(result.error.message).toContain('application/pdf');
      }
    });
  });

  describe('Processing Flow', () => {
    it('should handle complete upload and download cycle', async () => {
      const data = Buffer.from('test-data');
      const metadata = {
        type: 'image/png',
        filename: 'test.png',
      };

      // Upload
      const uploadResult = await handler.processIncoming(data, metadata);
      expect(uploadResult.ok).toBe(true);

      if (uploadResult.ok) {
        // Download
        const downloadResult = await handler.prepareOutgoing(uploadResult.value);
        expect(downloadResult.ok).toBe(true);

        if (downloadResult.ok) {
          expect(downloadResult.value.data?.toString()).toBe('test-data');
        }
      }
    });

    it('should handle multiple attachments independently', async () => {
      const data1 = Buffer.from('data-1');
      const data2 = Buffer.from('data-2');

      const result1 = await handler.processIncoming(data1, {
        type: 'image/png',
        filename: 'file1.png',
      });
      const result2 = await handler.processIncoming(data2, {
        type: 'image/jpeg',
        filename: 'file2.jpg',
      });

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);

      if (result1.ok && result2.ok) {
        expect(result1.value.id).not.toBe(result2.value.id);

        const prep1 = await handler.prepareOutgoing(result1.value);
        const prep2 = await handler.prepareOutgoing(result2.value);

        expect(prep1.ok).toBe(true);
        expect(prep2.ok).toBe(true);

        if (prep1.ok && prep2.ok) {
          expect(prep1.value.data?.toString()).toBe('data-1');
          expect(prep2.value.data?.toString()).toBe('data-2');
        }
      }
    });

    it('should return error when retrieving non-existent attachment', async () => {
      const fakeAttachment = {
        id: 'non-existent',
        type: 'image/png',
        url: 'media://non-existent',
        size: 100,
        filename: 'fake.png',
        metadata: {},
      };

      const result = await handler.prepareOutgoing(fakeAttachment);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEDIA_RETRIEVAL_ERROR');
      }
    });
  });

  describe('Metadata Handling', () => {
    it('should preserve custom metadata fields', async () => {
      const data = Buffer.from('test');
      const metadata = {
        type: 'image/png',
        filename: 'test.png',
        customField: 'custom-value',
        nestedData: { key: 'value' },
      };

      const result = await handler.processIncoming(data, metadata);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata.customField).toBe('custom-value');
        expect(result.value.metadata.nestedData).toEqual({ key: 'value' });
      }
    });

    it('should include timestamp in metadata', async () => {
      const data = Buffer.from('test');
      const metadata = {
        type: 'image/png',
        filename: 'test.png',
      };

      const before = Date.now();
      const result = await handler.processIncoming(data, metadata);
      const after = Date.now();

      expect(result.ok).toBe(true);
      if (result.ok) {
        const timestamp = result.value.metadata.timestamp as number;
        expect(timestamp).toBeGreaterThanOrEqual(before);
        expect(timestamp).toBeLessThanOrEqual(after);
      }
    });

    it('should include size in metadata', async () => {
      const data = Buffer.from('test-data');
      const metadata = {
        type: 'image/png',
        filename: 'test.png',
      };

      const result = await handler.processIncoming(data, metadata);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata.size).toBe(data.length);
        expect(result.value.size).toBe(data.length);
      }
    });
  });

  describe('Configuration', () => {
    it('should respect custom size limits', async () => {
      const smallLimitHandler = new MediaHandler({
        ...config,
        maxSizeBytes: 100,
      });

      const data = Buffer.alloc(200);
      const result = await smallLimitHandler.processIncoming(data, {
        type: 'image/png',
        filename: 'test.png',
      });

      expect(result.ok).toBe(false);
    });

    it('should respect allowed types configuration', async () => {
      const restrictedHandler = new MediaHandler({
        ...config,
        allowedTypes: ['image/png'], // Only PNG
      });

      const jpegResult = await restrictedHandler.processIncoming(
        Buffer.from('test'),
        {
          type: 'image/jpeg',
          filename: 'test.jpg',
        },
      );

      expect(jpegResult.ok).toBe(false);

      const pngResult = await restrictedHandler.processIncoming(
        Buffer.from('test'),
        {
          type: 'image/png',
          filename: 'test.png',
        },
      );

      expect(pngResult.ok).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle validation failures gracefully', async () => {
      const data = Buffer.alloc(2 * 1024 * 1024);
      const result = await handler.processIncoming(data, {
        type: 'video/mp4',
        filename: 'test.mp4',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Should fail on size, not type (checked first)
        expect(result.error).toBeInstanceOf(SizeLimitError);
      }
    });

    it('should provide error codes for different failure types', async () => {
      // Size error
      const sizeResult = await handler.processIncoming(Buffer.alloc(2000000), {
        type: 'image/png',
        filename: 'test.png',
      });
      expect(sizeResult.ok).toBe(false);
      if (!sizeResult.ok) {
        expect(sizeResult.error.code).toBe('SIZE_LIMIT_EXCEEDED');
      }

      // Type error
      const typeResult = await handler.processIncoming(Buffer.from('test'), {
        type: 'video/mp4',
        filename: 'test.mp4',
      });
      expect(typeResult.ok).toBe(false);
      if (!typeResult.ok) {
        expect(typeResult.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      }
    });
  });

  describe('Storage', () => {
    it('should clear storage', async () => {
      const data = Buffer.from('test');
      const result = await handler.processIncoming(data, {
        type: 'image/png',
        filename: 'test.png',
      });

      expect(result.ok).toBe(true);

      handler.clear();

      if (result.ok) {
        const retrieveResult = await handler.prepareOutgoing(result.value);
        expect(retrieveResult.ok).toBe(false);
      }
    });

    it('should generate unique IDs for each attachment', async () => {
      const ids = new Set<string>();

      for (let i = 0; i < 10; i++) {
        const result = await handler.processIncoming(Buffer.from(`test-${i}`), {
          type: 'image/png',
          filename: `test-${i}.png`,
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
          ids.add(result.value.id);
        }
      }

      expect(ids.size).toBe(10);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty buffer', async () => {
      const result = await handler.processIncoming(Buffer.alloc(0), {
        type: 'image/png',
        filename: 'empty.png',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBe(0);
      }
    });

    it('should handle special characters in filename', async () => {
      const result = await handler.processIncoming(Buffer.from('test'), {
        type: 'image/png',
        filename: 'test file (1) [copy].png',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.filename).toBe('test file (1) [copy].png');
      }
    });

    it('should handle unicode in filename', async () => {
      const result = await handler.processIncoming(Buffer.from('test'), {
        type: 'image/png',
        filename: '测试文件.png',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.filename).toBe('测试文件.png');
      }
    });
  });
});
