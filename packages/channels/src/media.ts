/**
 * Media Handler
 *
 * Handles media attachments including images, files, and other content types.
 */

import { KyneticError } from '@kynetic-bot/core';
import type { Result } from './types.js';

/**
 * Media storage configuration
 */
export interface MediaConfig {
  /** Maximum file size in bytes */
  maxSizeBytes: number;

  /** Allowed MIME types (e.g., ['image/png', 'image/jpeg']) */
  allowedTypes: string[];

  /** Storage backend */
  storage: 'memory' | 'local' | 's3';

  /** Storage path for local storage */
  storagePath?: string;

  /** S3 configuration (if using S3 storage) */
  s3Config?: {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

/**
 * Media attachment with metadata
 */
export interface MediaAttachment {
  /** Unique attachment identifier */
  id: string;

  /** MIME type (e.g., 'image/png', 'application/pdf') */
  type: string;

  /** URL or reference to the stored media */
  url: string;

  /** File size in bytes */
  size: number;

  /** Original filename */
  filename: string;

  /** Additional metadata */
  metadata: Record<string, unknown>;
}

/**
 * Media metadata for storage
 */
interface MediaMetadata {
  type: string;
  filename: string;
  size: number;
  timestamp: number;
  [key: string]: unknown;
}

/**
 * Error thrown when attachment size exceeds limit
 */
export class SizeLimitError extends KyneticError {
  constructor(
    message: string,
    public readonly maxSize: number,
    public readonly actualSize: number,
  ) {
    super(message, 'SIZE_LIMIT_EXCEEDED');
  }
}

/**
 * Error thrown when media type is not allowed
 */
export class UnsupportedMediaTypeError extends KyneticError {
  constructor(message: string, public readonly mediaType: string) {
    super(message, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

/**
 * Handles media attachment processing and storage
 */
export class MediaHandler {
  private storage = new Map<string, Buffer>();
  private idCounter = 0;

  constructor(private config: MediaConfig) {}

  /**
   * Process an incoming attachment
   *
   * @param data - Raw attachment data
   * @param metadata - Attachment metadata
   * @returns Result with MediaAttachment or error
   */
  async processIncoming(
    data: Buffer,
    metadata: {
      type: string;
      filename: string;
      [key: string]: unknown;
    },
  ): Promise<Result<MediaAttachment, KyneticError>> {
    // AC-3: Validate size
    const sizeValidation = this.validateSize(data.length);
    if (!sizeValidation.ok) {
      return sizeValidation;
    }

    // Validate type
    const typeValidation = this.validateType(metadata.type);
    if (!typeValidation.ok) {
      return typeValidation;
    }

    try {
      // AC-1: Store media with metadata
      const storageMetadata: MediaMetadata = {
        ...metadata,
        type: metadata.type,
        filename: metadata.filename,
        size: data.length,
        timestamp: Date.now(),
      };

      const id = await this.store(data, storageMetadata);

      // AC-1: Return attachment with metadata
      const attachment: MediaAttachment = {
        id,
        type: metadata.type,
        url: this.generateUrl(id),
        size: data.length,
        filename: metadata.filename,
        metadata: storageMetadata,
      };

      return { ok: true, value: attachment };
    } catch (error) {
      return {
        ok: false,
        error: new KyneticError(
          `Failed to process attachment: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'MEDIA_PROCESSING_ERROR',
        ),
      };
    }
  }

  /**
   * Prepare an outgoing attachment for delivery
   *
   * @param attachment - Media attachment to prepare
   * @returns Result with platform-specific reference or error
   */
  async prepareOutgoing(
    attachment: MediaAttachment,
  ): Promise<Result<{ url: string; data?: Buffer }, KyneticError>> {
    try {
      // AC-2: Retrieve stored media
      const data = await this.retrieve(attachment.id);

      // AC-2: Return reference for delivery
      return {
        ok: true,
        value: {
          url: attachment.url,
          data,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: new KyneticError(
          `Failed to retrieve attachment: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'MEDIA_RETRIEVAL_ERROR',
        ),
      };
    }
  }

  /**
   * Validate attachment size
   *
   * @param size - Attachment size in bytes
   * @returns Result with void or SizeLimitError
   */
  validateSize(size: number): Result<void, SizeLimitError> {
    // AC-3: Reject if size exceeds limit
    if (size > this.config.maxSizeBytes) {
      return {
        ok: false,
        error: new SizeLimitError(
          `Attachment size ${size} bytes exceeds limit of ${this.config.maxSizeBytes} bytes`,
          this.config.maxSizeBytes,
          size,
        ),
      };
    }

    return { ok: true, value: undefined };
  }

  /**
   * Validate media type
   *
   * @param type - MIME type
   * @returns Result with void or UnsupportedMediaTypeError
   */
  validateType(type: string): Result<void, UnsupportedMediaTypeError> {
    if (this.config.allowedTypes.length === 0) {
      // Allow all types if no restrictions
      return { ok: true, value: undefined };
    }

    if (!this.config.allowedTypes.includes(type)) {
      return {
        ok: false,
        error: new UnsupportedMediaTypeError(
          `Media type ${type} is not allowed. Allowed types: ${this.config.allowedTypes.join(', ')}`,
          type,
        ),
      };
    }

    return { ok: true, value: undefined };
  }

  /**
   * Store media data
   *
   * @param data - Media data buffer
   * @param metadata - Storage metadata
   * @returns Media identifier
   */
  private async store(data: Buffer, metadata: MediaMetadata): Promise<string> {
    const id = this.generateId();

    switch (this.config.storage) {
      case 'memory':
        // Store in memory (for testing/development)
        this.storage.set(id, data);
        break;

      case 'local':
        // TODO: Implement local file system storage
        throw new Error('Local storage not yet implemented');

      case 's3':
        // TODO: Implement S3 storage
        throw new Error('S3 storage not yet implemented');

      default:
        throw new Error(`Unknown storage backend: ${this.config.storage}`);
    }

    return id;
  }

  /**
   * Retrieve stored media
   *
   * @param id - Media identifier
   * @returns Media data buffer
   */
  private async retrieve(id: string): Promise<Buffer> {
    switch (this.config.storage) {
      case 'memory':
        const data = this.storage.get(id);
        if (!data) {
          throw new Error(`Media not found: ${id}`);
        }
        return data;

      case 'local':
        // TODO: Implement local file system retrieval
        throw new Error('Local storage not yet implemented');

      case 's3':
        // TODO: Implement S3 retrieval
        throw new Error('S3 storage not yet implemented');

      default:
        throw new Error(`Unknown storage backend: ${this.config.storage}`);
    }
  }

  /**
   * Generate a unique media identifier
   */
  private generateId(): string {
    return `media_${Date.now()}_${++this.idCounter}`;
  }

  /**
   * Generate a URL for media access
   *
   * @param id - Media identifier
   * @returns Media URL
   */
  private generateUrl(id: string): string {
    // In production, this would be a real URL to access the media
    // For now, return a placeholder
    return `media://${id}`;
  }

  /**
   * Clear all stored media (for testing)
   */
  clear(): void {
    this.storage.clear();
    this.idCounter = 0;
  }
}
