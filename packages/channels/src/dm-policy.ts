/**
 * DM Policy Manager
 *
 * Manages DM request workflows supporting pairing-required and open access policies.
 * Pending requests are stored in .kbot/dm-policy/ using YAML for persistence.
 *
 * @see @channel-dm-policy
 */

import * as fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { ulid } from 'ulid';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { KyneticError } from '@kynetic-bot/core';

// ============================================================================
// Types and Schemas
// ============================================================================

/**
 * DM access policies
 * - open: Any user can start a conversation immediately
 * - pairing_required: Users must be approved by admin before conversation starts
 */
export type DMPolicy = 'open' | 'pairing_required';
export const DMPolicySchema = z.enum(['open', 'pairing_required']);

/**
 * Status of a pending DM request
 */
export type DMRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export const DMRequestStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);

/**
 * Pending DM request schema
 */
export const PendingDMRequestSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  platform: z.string().min(1),
  channel: z.string().min(1),
  pairingCode: z.string().length(6),
  status: DMRequestStatusSchema,
  createdAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  approvedAt: z.number().int().positive().optional(),
  rejectedAt: z.number().int().positive().optional(),
  rejectionReason: z.string().optional(),
});
export type PendingDMRequest = z.infer<typeof PendingDMRequestSchema>;

/**
 * Input for creating a new DM request
 */
export const CreateDMRequestInputSchema = PendingDMRequestSchema.omit({
  id: true,
  pairingCode: true,
  status: true,
  createdAt: true,
  approvedAt: true,
  rejectedAt: true,
  rejectionReason: true,
}).extend({
  expiresAt: z.number().int().positive().optional(),
});
export type CreateDMRequestInput = z.infer<typeof CreateDMRequestInputSchema>;

/**
 * Channel configuration for DM policy
 */
export interface ChannelPolicyConfig {
  channel: string;
  policy: DMPolicy;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown for DM policy operations
 */
export class DMPolicyError extends KyneticError {
  readonly requestId?: string;

  constructor(
    message: string,
    code: string,
    requestId?: string,
    context?: Record<string, unknown>,
  ) {
    super(message, `DM_POLICY_${code}`, { ...context, requestId });
    this.requestId = requestId;
  }
}

/**
 * Error thrown for validation failures
 */
export class DMPolicyValidationError extends KyneticError {
  readonly field?: string;

  constructor(message: string, field?: string, context?: Record<string, unknown>) {
    super(message, 'DM_POLICY_VALIDATION_ERROR', { ...context, field });
    this.field = field;
  }
}

// ============================================================================
// Events
// ============================================================================

/**
 * Events emitted by DMPolicyManager
 */
export interface DMPolicyEvents {
  'request:created': { request: PendingDMRequest };
  'request:approved': { request: PendingDMRequest };
  'request:rejected': { request: PendingDMRequest; reason?: string };
  'request:expired': { request: PendingDMRequest };
  'error': { error: Error; operation: string; requestId?: string };
}

// ============================================================================
// DMPolicyManager
// ============================================================================

/**
 * Options for creating a DMPolicyManager
 */
export interface DMPolicyManagerOptions {
  /** Base directory for storage (e.g., .kbot/) */
  baseDir: string;
  /** Default TTL for requests in milliseconds (default: 60 minutes) */
  defaultTtlMs?: number;
  /** Event emitter for observability (optional) */
  emitter?: EventEmitter;
}

/**
 * DMPolicyManager manages DM request workflows with approval gates.
 *
 * Storage layout:
 * ```
 * {baseDir}/dm-policy/
 * ├── pending-requests.yaml  # Active pending requests
 * └── channel-policies.yaml  # Channel policy configurations
 * ```
 *
 * @example
 * ```typescript
 * const manager = new DMPolicyManager({ baseDir: '.kbot' });
 *
 * // Set channel policy
 * await manager.setChannelPolicy('discord:dm:*', 'pairing_required');
 *
 * // Check access for new user
 * const result = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
 *
 * if (result.status === 'pending') {
 *   // User needs to wait for approval
 *   console.log(`Pairing code: ${result.request.pairingCode}`);
 * }
 * ```
 */
export class DMPolicyManager {
  private readonly baseDir: string;
  private readonly policyDir: string;
  private readonly defaultTtlMs: number;
  private readonly emitter?: EventEmitter;

  constructor(options: DMPolicyManagerOptions) {
    this.baseDir = options.baseDir;
    this.policyDir = path.join(options.baseDir, 'dm-policy');
    this.defaultTtlMs = options.defaultTtlMs ?? 60 * 60 * 1000; // 60 minutes
    this.emitter = options.emitter;
  }

  // ==========================================================================
  // Path Helpers
  // ==========================================================================

  private pendingRequestsPath(): string {
    return path.join(this.policyDir, 'pending-requests.yaml');
  }

  private channelPoliciesPath(): string {
    return path.join(this.policyDir, 'channel-policies.yaml');
  }

  private lockFilePath(): string {
    return path.join(this.policyDir, '.lock');
  }

  // ==========================================================================
  // Lock Helpers
  // ==========================================================================

  private acquireLock(timeout = 5000): boolean {
    const lockPath = this.lockFilePath();
    const startTime = Date.now();

    // Ensure directory exists
    if (!existsSync(this.policyDir)) {
      return true; // First operation will create directory
    }

    while (Date.now() - startTime < timeout) {
      try {
        writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        return true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          const waitUntil = Date.now() + 10;
          while (Date.now() < waitUntil) {
            // Spin
          }
          continue;
        }
        throw err;
      }
    }
    return false;
  }

  private releaseLock(): void {
    const lockPath = this.lockFilePath();
    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore
    }
  }

  // ==========================================================================
  // Emit Helper
  // ==========================================================================

  private emit<K extends keyof DMPolicyEvents>(event: K, data: DMPolicyEvents[K]): void {
    if (this.emitter) {
      this.emitter.emit(event, data);
    }
  }

  // ==========================================================================
  // Internal Storage Operations
  // ==========================================================================

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.policyDir, { recursive: true });
  }

  private async readPendingRequests(): Promise<PendingDMRequest[]> {
    const filePath = this.pendingRequestsPath();
    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = yamlParse(content);
      if (!data || !Array.isArray(data.requests)) {
        return [];
      }

      // Validate each request
      const valid: PendingDMRequest[] = [];
      for (const req of data.requests) {
        const result = PendingDMRequestSchema.safeParse(req);
        if (result.success) {
          valid.push(result.data);
        }
      }
      return valid;
    } catch {
      return [];
    }
  }

  private async writePendingRequests(requests: PendingDMRequest[]): Promise<void> {
    await this.ensureDir();
    const content = yamlStringify({ requests });
    await fs.writeFile(this.pendingRequestsPath(), content, 'utf-8');
  }

  private async readChannelPolicies(): Promise<Record<string, DMPolicy>> {
    const filePath = this.channelPoliciesPath();
    if (!existsSync(filePath)) {
      return {};
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = yamlParse(content);
      if (!data || typeof data.policies !== 'object') {
        return {};
      }
      return data.policies as Record<string, DMPolicy>;
    } catch {
      return {};
    }
  }

  private async writeChannelPolicies(policies: Record<string, DMPolicy>): Promise<void> {
    await this.ensureDir();
    const content = yamlStringify({ policies });
    await fs.writeFile(this.channelPoliciesPath(), content, 'utf-8');
  }

  // ==========================================================================
  // Pairing Code Generation
  // ==========================================================================

  /**
   * Generate a 6-character alphanumeric pairing code
   */
  private generatePairingCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude similar chars
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  // ==========================================================================
  // Channel Policy Operations
  // ==========================================================================

  /**
   * Set the DM policy for a channel pattern.
   *
   * @param channel - Channel pattern (can use * as wildcard)
   * @param policy - Policy to apply
   */
  async setChannelPolicy(channel: string, policy: DMPolicy): Promise<void> {
    if (!this.acquireLock()) {
      throw new DMPolicyError('Failed to acquire lock', 'LOCK_FAILED');
    }

    try {
      const policies = await this.readChannelPolicies();
      policies[channel] = policy;
      await this.writeChannelPolicies(policies);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Get the DM policy for a specific channel.
   *
   * @param channel - Channel to check
   * @returns Policy for the channel, or 'open' if not configured
   */
  async getChannelPolicy(channel: string): Promise<DMPolicy> {
    const policies = await this.readChannelPolicies();

    // Direct match
    if (policies[channel]) {
      return policies[channel];
    }

    // Wildcard matching (e.g., discord:dm:* matches discord:dm:user123)
    for (const [pattern, policy] of Object.entries(policies)) {
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (channel.startsWith(prefix)) {
          return policy;
        }
      }
    }

    // Default to open
    return 'open';
  }

  // ==========================================================================
  // Access Control
  // ==========================================================================

  /**
   * Check access for a user on a channel.
   *
   * AC: @channel-dm-policy ac-1 - Creates pending request for pairing_required
   * AC: @channel-dm-policy ac-3 - Immediate access for open policy
   * AC: @channel-dm-policy ac-5 - Idempotent: returns existing pending request
   *
   * @param channel - Channel the user is trying to access
   * @param userId - User identifier
   * @param platform - Platform identifier
   * @returns Access status and request if pending
   */
  async checkAccess(
    channel: string,
    userId: string,
    platform: string,
  ): Promise<
    | { status: 'allowed' }
    | { status: 'pending'; request: PendingDMRequest }
    | { status: 'denied'; reason?: string }
  > {
    const policy = await this.getChannelPolicy(channel);

    // AC-3: Open policy allows immediate access
    if (policy === 'open') {
      return { status: 'allowed' };
    }

    // pairing_required policy
    if (!this.acquireLock()) {
      throw new DMPolicyError('Failed to acquire lock', 'LOCK_FAILED');
    }

    try {
      const requests = await this.readPendingRequests();

      // AC-5: Check for existing pending or approved request (idempotent)
      const existing = requests.find(
        (r) => r.userId === userId && r.platform === platform && r.channel === channel,
      );

      if (existing) {
        // Check if expired
        if (existing.status === 'pending' && existing.expiresAt < Date.now()) {
          existing.status = 'expired';
          await this.writePendingRequests(requests);
          this.emit('request:expired', { request: existing });
          // Fall through to create new request
        } else if (existing.status === 'approved') {
          return { status: 'allowed' };
        } else if (existing.status === 'rejected') {
          return { status: 'denied', reason: existing.rejectionReason };
        } else if (existing.status === 'pending') {
          return { status: 'pending', request: existing };
        }
      }

      // AC-1: Create new pending request
      const newRequest: PendingDMRequest = {
        id: ulid(),
        userId,
        platform,
        channel,
        pairingCode: this.generatePairingCode(),
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + this.defaultTtlMs,
      };

      // Add to list (replacing any expired request for same user)
      const filtered = requests.filter(
        (r) =>
          !(r.userId === userId && r.platform === platform && r.channel === channel && r.status === 'expired'),
      );
      filtered.push(newRequest);
      await this.writePendingRequests(filtered);

      this.emit('request:created', { request: newRequest });

      return { status: 'pending', request: newRequest };
    } finally {
      this.releaseLock();
    }
  }

  // ==========================================================================
  // Request Management
  // ==========================================================================

  /**
   * Get a pending request by ID.
   *
   * @param requestId - Request ID to look up
   * @returns Request or null if not found
   */
  async getRequest(requestId: string): Promise<PendingDMRequest | null> {
    const requests = await this.readPendingRequests();
    return requests.find((r) => r.id === requestId) ?? null;
  }

  /**
   * Get pending request by pairing code.
   *
   * @param pairingCode - 6-character pairing code
   * @returns Request or null if not found
   */
  async getRequestByPairingCode(pairingCode: string): Promise<PendingDMRequest | null> {
    const requests = await this.readPendingRequests();
    return requests.find((r) => r.pairingCode === pairingCode && r.status === 'pending') ?? null;
  }

  /**
   * List pending requests with optional filtering.
   *
   * @param filters - Filter options
   * @returns Array of matching requests
   */
  async listRequests(filters?: {
    userId?: string;
    platform?: string;
    status?: DMRequestStatus;
    channel?: string;
  }): Promise<PendingDMRequest[]> {
    let requests = await this.readPendingRequests();

    if (filters?.userId) {
      requests = requests.filter((r) => r.userId === filters.userId);
    }
    if (filters?.platform) {
      requests = requests.filter((r) => r.platform === filters.platform);
    }
    if (filters?.status) {
      requests = requests.filter((r) => r.status === filters.status);
    }
    if (filters?.channel) {
      requests = requests.filter((r) => r.channel === filters.channel);
    }

    return requests;
  }

  /**
   * Approve a pending request.
   *
   * AC: @channel-dm-policy ac-2 - Approves request and creates session
   *
   * @param requestId - Request ID to approve
   * @throws DMPolicyError if request not found or not pending
   */
  async approveRequest(requestId: string): Promise<PendingDMRequest> {
    if (!this.acquireLock()) {
      throw new DMPolicyError('Failed to acquire lock', 'LOCK_FAILED');
    }

    try {
      const requests = await this.readPendingRequests();
      const request = requests.find((r) => r.id === requestId);

      if (!request) {
        throw new DMPolicyError('Request not found', 'REQUEST_NOT_FOUND', requestId);
      }

      if (request.status !== 'pending') {
        throw new DMPolicyError(
          `Cannot approve request with status: ${request.status}`,
          'INVALID_STATUS',
          requestId,
          { currentStatus: request.status },
        );
      }

      // Check if expired
      if (request.expiresAt < Date.now()) {
        request.status = 'expired';
        await this.writePendingRequests(requests);
        this.emit('request:expired', { request });
        throw new DMPolicyError('Request has expired', 'REQUEST_EXPIRED', requestId);
      }

      // AC-2: Approve the request
      request.status = 'approved';
      request.approvedAt = Date.now();
      await this.writePendingRequests(requests);

      this.emit('request:approved', { request });

      return request;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Reject a pending request.
   *
   * AC: @channel-dm-policy ac-4 - Rejects request and notifies user
   *
   * @param requestId - Request ID to reject
   * @param reason - Optional rejection reason
   * @throws DMPolicyError if request not found or not pending
   */
  async rejectRequest(requestId: string, reason?: string): Promise<PendingDMRequest> {
    if (!this.acquireLock()) {
      throw new DMPolicyError('Failed to acquire lock', 'LOCK_FAILED');
    }

    try {
      const requests = await this.readPendingRequests();
      const request = requests.find((r) => r.id === requestId);

      if (!request) {
        throw new DMPolicyError('Request not found', 'REQUEST_NOT_FOUND', requestId);
      }

      if (request.status !== 'pending') {
        throw new DMPolicyError(
          `Cannot reject request with status: ${request.status}`,
          'INVALID_STATUS',
          requestId,
          { currentStatus: request.status },
        );
      }

      // AC-4: Reject the request
      request.status = 'rejected';
      request.rejectedAt = Date.now();
      request.rejectionReason = reason;
      await this.writePendingRequests(requests);

      this.emit('request:rejected', { request, reason });

      return request;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Clean up expired requests.
   *
   * @returns Number of requests marked as expired
   */
  async cleanupExpired(): Promise<number> {
    if (!this.acquireLock()) {
      throw new DMPolicyError('Failed to acquire lock', 'LOCK_FAILED');
    }

    try {
      const requests = await this.readPendingRequests();
      const now = Date.now();
      let count = 0;

      for (const request of requests) {
        if (request.status === 'pending' && request.expiresAt < now) {
          request.status = 'expired';
          this.emit('request:expired', { request });
          count++;
        }
      }

      if (count > 0) {
        await this.writePendingRequests(requests);
      }

      return count;
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Remove resolved requests (approved, rejected, expired) older than retention period.
   *
   * @param retentionMs - Retention period in milliseconds (default: 24 hours)
   * @returns Number of requests removed
   */
  async compactRequests(retentionMs = 24 * 60 * 60 * 1000): Promise<number> {
    if (!this.acquireLock()) {
      throw new DMPolicyError('Failed to acquire lock', 'LOCK_FAILED');
    }

    try {
      const requests = await this.readPendingRequests();
      const cutoff = Date.now() - retentionMs;

      const kept = requests.filter((r) => {
        if (r.status === 'pending') return true;
        if (r.status === 'approved' && r.approvedAt && r.approvedAt > cutoff) return true;
        if (r.status === 'rejected' && r.rejectedAt && r.rejectedAt > cutoff) return true;
        if (r.status === 'expired' && r.expiresAt > cutoff) return true;
        return false;
      });

      const removed = requests.length - kept.length;

      if (removed > 0) {
        await this.writePendingRequests(kept);
      }

      return removed;
    } finally {
      this.releaseLock();
    }
  }
}
