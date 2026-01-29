/**
 * DMPolicyManager Tests
 *
 * Tests for DM request workflows with pairing-required and open policies.
 *
 * @see @channel-dm-policy
 */

import * as fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as yamlParse } from 'yaml';

import {
  DMPolicyManager,
  DMPolicyError,
  type PendingDMRequest,
  type DMPolicyEvents,
} from '../src/dm-policy.js';

describe('DMPolicyManager', () => {
  let tempDir: string;
  let manager: DMPolicyManager;
  let emitter: EventEmitter;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-policy-test-'));
    emitter = new EventEmitter();
    manager = new DMPolicyManager({
      baseDir: tempDir,
      defaultTtlMs: 60 * 60 * 1000, // 60 minutes
      emitter,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('Channel Policy Configuration', () => {
    it('sets and retrieves channel policy', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const policy = await manager.getChannelPolicy('discord:dm:user123');
      expect(policy).toBe('pairing_required');
    });

    it('defaults to open policy for unconfigured channels', async () => {
      const policy = await manager.getChannelPolicy('unknown:channel');
      expect(policy).toBe('open');
    });

    it('matches exact channel before wildcard', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');
      await manager.setChannelPolicy('discord:dm:vip123', 'open');

      const vipPolicy = await manager.getChannelPolicy('discord:dm:vip123');
      expect(vipPolicy).toBe('open');

      const normalPolicy = await manager.getChannelPolicy('discord:dm:user456');
      expect(normalPolicy).toBe('pairing_required');
    });

    it('persists policy to YAML file', async () => {
      await manager.setChannelPolicy('whatsapp:*', 'pairing_required');

      const filePath = path.join(tempDir, 'dm-policy', 'channel-policies.yaml');
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      const parsed = yamlParse(content);
      expect(parsed.policies['whatsapp:*']).toBe('pairing_required');
    });
  });

  describe('checkAccess', () => {
    // AC: @channel-dm-policy ac-3 - Open policy allows immediate access
    it('allows immediate access with open policy', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'open');

      const result = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');

      expect(result.status).toBe('allowed');
    });

    // AC: @channel-dm-policy ac-1 - Creates pending request for pairing_required
    it('creates pending request for pairing_required policy', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const result = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');

      expect(result.status).toBe('pending');
      if (result.status === 'pending') {
        expect(result.request.userId).toBe('user123');
        expect(result.request.platform).toBe('discord');
        expect(result.request.pairingCode).toHaveLength(6);
        expect(result.request.status).toBe('pending');
      }
    });

    it('emits request:created event', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const events: Array<{ request: PendingDMRequest }> = [];
      emitter.on('request:created', (data) => events.push(data));

      await manager.checkAccess('discord:dm:user123', 'user123', 'discord');

      expect(events).toHaveLength(1);
      expect(events[0].request.userId).toBe('user123');
    });

    // AC: @channel-dm-policy ac-5 - Idempotent: returns existing pending request
    it('returns existing pending request for same user (idempotent)', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const result1 = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      const result2 = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');

      expect(result1.status).toBe('pending');
      expect(result2.status).toBe('pending');

      if (result1.status === 'pending' && result2.status === 'pending') {
        expect(result1.request.id).toBe(result2.request.id);
        expect(result1.request.pairingCode).toBe(result2.request.pairingCode);
      }
    });

    it('allows access for approved request', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      // Create and approve request
      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(createResult.status).toBe('pending');
      if (createResult.status === 'pending') {
        await manager.approveRequest(createResult.request.id);
      }

      // Check access again
      const result = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(result.status).toBe('allowed');
    });

    it('denies access for rejected request', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      // Create and reject request
      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(createResult.status).toBe('pending');
      if (createResult.status === 'pending') {
        await manager.rejectRequest(createResult.request.id, 'Spam suspected');
      }

      // Check access again
      const result = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(result.status).toBe('denied');
      if (result.status === 'denied') {
        expect(result.reason).toBe('Spam suspected');
      }
    });

    it('creates new request when previous expired', async () => {
      // Use short TTL
      const shortTtlManager = new DMPolicyManager({
        baseDir: tempDir,
        defaultTtlMs: 1, // 1ms TTL
        emitter,
      });

      await shortTtlManager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const result1 = await shortTtlManager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(result1.status).toBe('pending');

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 10));

      const result2 = await shortTtlManager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(result2.status).toBe('pending');

      if (result1.status === 'pending' && result2.status === 'pending') {
        expect(result1.request.id).not.toBe(result2.request.id); // New request
      }
    });
  });

  describe('getRequest', () => {
    it('returns request by ID', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(createResult.status).toBe('pending');

      if (createResult.status === 'pending') {
        const request = await manager.getRequest(createResult.request.id);
        expect(request).not.toBeNull();
        expect(request?.userId).toBe('user123');
      }
    });

    it('returns null for non-existent request', async () => {
      const request = await manager.getRequest('nonexistent');
      expect(request).toBeNull();
    });
  });

  describe('getRequestByPairingCode', () => {
    it('returns pending request by pairing code', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(createResult.status).toBe('pending');

      if (createResult.status === 'pending') {
        const request = await manager.getRequestByPairingCode(createResult.request.pairingCode);
        expect(request).not.toBeNull();
        expect(request?.id).toBe(createResult.request.id);
      }
    });

    it('returns null for approved request pairing code', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      if (createResult.status === 'pending') {
        await manager.approveRequest(createResult.request.id);

        const request = await manager.getRequestByPairingCode(createResult.request.pairingCode);
        expect(request).toBeNull(); // Only returns pending requests
      }
    });
  });

  describe('listRequests', () => {
    it('lists all requests', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      await manager.checkAccess('discord:dm:user1', 'user1', 'discord');
      await manager.checkAccess('discord:dm:user2', 'user2', 'discord');

      const requests = await manager.listRequests();
      expect(requests).toHaveLength(2);
    });

    it('filters by status', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const result1 = await manager.checkAccess('discord:dm:user1', 'user1', 'discord');
      const result2 = await manager.checkAccess('discord:dm:user2', 'user2', 'discord');

      if (result1.status === 'pending') {
        await manager.approveRequest(result1.request.id);
      }

      const pending = await manager.listRequests({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0].userId).toBe('user2');

      const approved = await manager.listRequests({ status: 'approved' });
      expect(approved).toHaveLength(1);
      expect(approved[0].userId).toBe('user1');
    });

    it('filters by platform', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');
      await manager.setChannelPolicy('whatsapp:*', 'pairing_required');

      await manager.checkAccess('discord:dm:user1', 'user1', 'discord');
      await manager.checkAccess('whatsapp:user2', 'user2', 'whatsapp');

      const discordRequests = await manager.listRequests({ platform: 'discord' });
      expect(discordRequests).toHaveLength(1);
      expect(discordRequests[0].platform).toBe('discord');
    });
  });

  describe('approveRequest', () => {
    // AC: @channel-dm-policy ac-2 - Admin approves request
    it('approves pending request', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(createResult.status).toBe('pending');

      if (createResult.status === 'pending') {
        const approved = await manager.approveRequest(createResult.request.id);

        expect(approved.status).toBe('approved');
        expect(approved.approvedAt).toBeDefined();
      }
    });

    it('emits request:approved event', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(createResult.status).toBe('pending');

      const events: Array<{ request: PendingDMRequest }> = [];
      emitter.on('request:approved', (data) => events.push(data));

      if (createResult.status === 'pending') {
        await manager.approveRequest(createResult.request.id);
      }

      expect(events).toHaveLength(1);
      expect(events[0].request.status).toBe('approved');
    });

    it('throws for non-existent request', async () => {
      await expect(manager.approveRequest('nonexistent')).rejects.toThrow(DMPolicyError);
    });

    it('throws for already approved request', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      if (createResult.status === 'pending') {
        await manager.approveRequest(createResult.request.id);

        await expect(manager.approveRequest(createResult.request.id)).rejects.toThrow(DMPolicyError);
      }
    });

    it('throws for expired request', async () => {
      const shortTtlManager = new DMPolicyManager({
        baseDir: tempDir,
        defaultTtlMs: 1,
        emitter,
      });

      await shortTtlManager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const createResult = await shortTtlManager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(createResult.status).toBe('pending');

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 10));

      if (createResult.status === 'pending') {
        await expect(shortTtlManager.approveRequest(createResult.request.id)).rejects.toThrow(
          DMPolicyError,
        );
      }
    });
  });

  describe('rejectRequest', () => {
    // AC: @channel-dm-policy ac-4 - Admin denies request
    it('rejects pending request', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(createResult.status).toBe('pending');

      if (createResult.status === 'pending') {
        const rejected = await manager.rejectRequest(createResult.request.id, 'Spam suspected');

        expect(rejected.status).toBe('rejected');
        expect(rejected.rejectedAt).toBeDefined();
        expect(rejected.rejectionReason).toBe('Spam suspected');
      }
    });

    it('emits request:rejected event', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(createResult.status).toBe('pending');

      const events: Array<{ request: PendingDMRequest; reason?: string }> = [];
      emitter.on('request:rejected', (data) => events.push(data));

      if (createResult.status === 'pending') {
        await manager.rejectRequest(createResult.request.id, 'Not allowed');
      }

      expect(events).toHaveLength(1);
      expect(events[0].request.status).toBe('rejected');
      expect(events[0].reason).toBe('Not allowed');
    });

    it('throws for non-existent request', async () => {
      await expect(manager.rejectRequest('nonexistent')).rejects.toThrow(DMPolicyError);
    });
  });

  describe('cleanupExpired', () => {
    it('marks expired pending requests', async () => {
      const shortTtlManager = new DMPolicyManager({
        baseDir: tempDir,
        defaultTtlMs: 1,
        emitter,
      });

      await shortTtlManager.setChannelPolicy('discord:dm:*', 'pairing_required');

      await shortTtlManager.checkAccess('discord:dm:user1', 'user1', 'discord');
      await shortTtlManager.checkAccess('discord:dm:user2', 'user2', 'discord');

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 10));

      const count = await shortTtlManager.cleanupExpired();
      expect(count).toBe(2);

      const pending = await shortTtlManager.listRequests({ status: 'pending' });
      expect(pending).toHaveLength(0);

      const expired = await shortTtlManager.listRequests({ status: 'expired' });
      expect(expired).toHaveLength(2);
    });

    it('emits request:expired events', async () => {
      const shortTtlManager = new DMPolicyManager({
        baseDir: tempDir,
        defaultTtlMs: 1,
        emitter,
      });

      await shortTtlManager.setChannelPolicy('discord:dm:*', 'pairing_required');

      await shortTtlManager.checkAccess('discord:dm:user1', 'user1', 'discord');

      await new Promise((r) => setTimeout(r, 10));

      const events: Array<{ request: PendingDMRequest }> = [];
      emitter.on('request:expired', (data) => events.push(data));

      await shortTtlManager.cleanupExpired();

      expect(events).toHaveLength(1);
    });
  });

  describe('compactRequests', () => {
    it('removes old resolved requests', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      // Create and approve a request
      const result = await manager.checkAccess('discord:dm:user1', 'user1', 'discord');
      if (result.status === 'pending') {
        await manager.approveRequest(result.request.id);
      }

      // Compact with 0 retention (remove all resolved)
      const removed = await manager.compactRequests(0);
      expect(removed).toBe(1);

      const all = await manager.listRequests();
      expect(all).toHaveLength(0);
    });

    it('keeps pending requests', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      await manager.checkAccess('discord:dm:user1', 'user1', 'discord');

      const removed = await manager.compactRequests(0);
      expect(removed).toBe(0);

      const all = await manager.listRequests();
      expect(all).toHaveLength(1);
    });
  });

  describe('Pairing Code', () => {
    it('generates unique 6-character codes', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const codes = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const result = await manager.checkAccess(`discord:dm:user${i}`, `user${i}`, 'discord');
        if (result.status === 'pending') {
          expect(result.request.pairingCode).toHaveLength(6);
          codes.add(result.request.pairingCode);
        }
      }

      // All codes should be unique
      expect(codes.size).toBe(10);
    });

    it('uses alphanumeric characters only', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const result = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      if (result.status === 'pending') {
        expect(result.request.pairingCode).toMatch(/^[A-Z0-9]{6}$/);
      }
    });
  });

  describe('Persistence', () => {
    it('persists pending requests to YAML', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      await manager.checkAccess('discord:dm:user123', 'user123', 'discord');

      const filePath = path.join(tempDir, 'dm-policy', 'pending-requests.yaml');
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      const parsed = yamlParse(content);
      expect(parsed.requests).toHaveLength(1);
      expect(parsed.requests[0].userId).toBe('user123');
    });

    it('survives manager restart', async () => {
      await manager.setChannelPolicy('discord:dm:*', 'pairing_required');

      const createResult = await manager.checkAccess('discord:dm:user123', 'user123', 'discord');
      expect(createResult.status).toBe('pending');

      // Create new manager instance (simulating restart)
      const newManager = new DMPolicyManager({ baseDir: tempDir });

      // Should find existing policy and request
      const policy = await newManager.getChannelPolicy('discord:dm:user123');
      expect(policy).toBe('pairing_required');

      const requests = await newManager.listRequests({ userId: 'user123' });
      expect(requests).toHaveLength(1);
    });
  });
});
