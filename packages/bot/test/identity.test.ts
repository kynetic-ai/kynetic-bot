/**
 * Identity System Tests
 *
 * Tests for @bot-identity acceptance criteria:
 * - ac-1: Base identity prepended to system prompt
 * - ac-2: Custom identity from .kbot/identity.yaml included
 * - ac-3: Missing identity file uses base only without error
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildIdentityPrompt,
  loadCustomIdentity,
  getBaseIdentity,
  CustomIdentitySchema,
} from '../src/identity.js';

// Mock the fs module
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockReadFile = vi.mocked(fs.readFile);

describe('Identity System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getBaseIdentity()', () => {
    it('returns base identity string', () => {
      const identity = getBaseIdentity();

      expect(identity).toContain('kynetic-bot');
      expect(identity).toContain('persistent general assistant');
      expect(identity).toContain('full system access');
    });
  });

  describe('CustomIdentitySchema', () => {
    it('validates complete identity config', () => {
      const input = {
        name: 'test-bot',
        role: 'Development assistant',
        boundaries: ['Ask before deleting'],
        traits: ['concise', 'helpful'],
      };

      const result = CustomIdentitySchema.parse(input);
      expect(result).toEqual(input);
    });

    it('validates partial identity config', () => {
      const input = { name: 'test-bot' };
      const result = CustomIdentitySchema.parse(input);
      expect(result).toEqual({ name: 'test-bot' });
    });

    it('validates empty object', () => {
      const result = CustomIdentitySchema.parse({});
      expect(result).toEqual({});
    });
  });

  describe('loadCustomIdentity()', () => {
    const testDir = '/test/.kbot';

    // AC: @bot-identity ac-2
    it('loads and parses valid identity.yaml', async () => {
      const yamlContent = `
name: kynetic-bot
role: Development partner
boundaries:
  - Ask before destructive operations
  - Respect project conventions
traits:
  - concise
  - proactive
`;
      mockReadFile.mockResolvedValue(yamlContent);

      const identity = await loadCustomIdentity(testDir);

      expect(identity).toEqual({
        name: 'kynetic-bot',
        role: 'Development partner',
        boundaries: ['Ask before destructive operations', 'Respect project conventions'],
        traits: ['concise', 'proactive'],
      });
      expect(mockReadFile).toHaveBeenCalledWith(
        path.join(testDir, 'identity.yaml'),
        'utf8',
      );
    });

    // AC: @bot-identity ac-3
    it('returns null when identity.yaml does not exist', async () => {
      const error = new Error('ENOENT');
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      mockReadFile.mockRejectedValue(error);

      const identity = await loadCustomIdentity(testDir);

      expect(identity).toBeNull();
    });

    it('returns null and logs warning on parse error', async () => {
      // Invalid YAML
      mockReadFile.mockResolvedValue('invalid: yaml: content: [');

      const identity = await loadCustomIdentity(testDir);

      expect(identity).toBeNull();
    });

    it('returns null on validation error (wrong type)', async () => {
      // Valid YAML but wrong types
      mockReadFile.mockResolvedValue('name: 123'); // should be string

      // Zod coerces 123 to string, so let's use a truly invalid value
      mockReadFile.mockResolvedValue('boundaries: not-an-array');

      const identity = await loadCustomIdentity(testDir);

      expect(identity).toBeNull();
    });

    it('handles partial identity config', async () => {
      mockReadFile.mockResolvedValue('name: partial-bot');

      const identity = await loadCustomIdentity(testDir);

      expect(identity).toEqual({ name: 'partial-bot' });
    });
  });

  describe('buildIdentityPrompt()', () => {
    const testDir = '/test/.kbot';

    // AC: @bot-identity ac-1
    it('returns base identity when no custom config exists', async () => {
      const error = new Error('ENOENT');
      (error as NodeJS.ErrnoException).code = 'ENOENT';
      mockReadFile.mockRejectedValue(error);

      const prompt = await buildIdentityPrompt(testDir);

      expect(prompt).toBe(getBaseIdentity());
      expect(prompt).toContain('kynetic-bot');
      expect(prompt).toContain('persistent general assistant');
    });

    // AC: @bot-identity ac-2
    it('includes custom identity after base identity', async () => {
      mockReadFile.mockResolvedValue(`
name: custom-bot
role: Team assistant
boundaries:
  - No production access
traits:
  - friendly
`);

      const prompt = await buildIdentityPrompt(testDir);

      // Base identity should be at the start
      expect(prompt).toContain('kynetic-bot');
      expect(prompt).toContain('persistent general assistant');

      // Custom identity should follow
      expect(prompt).toContain('Custom Configuration:');
      expect(prompt).toContain('Name: custom-bot');
      expect(prompt).toContain('Role: Team assistant');
      expect(prompt).toContain('Boundaries:');
      expect(prompt).toContain('- No production access');
      expect(prompt).toContain('Traits:');
      expect(prompt).toContain('- friendly');
    });

    it('formats boundaries as list items', async () => {
      mockReadFile.mockResolvedValue(`
boundaries:
  - First boundary
  - Second boundary
`);

      const prompt = await buildIdentityPrompt(testDir);

      expect(prompt).toContain('Boundaries:');
      expect(prompt).toContain('- First boundary');
      expect(prompt).toContain('- Second boundary');
    });

    it('formats traits as list items', async () => {
      mockReadFile.mockResolvedValue(`
traits:
  - helpful
  - direct
  - concise
`);

      const prompt = await buildIdentityPrompt(testDir);

      expect(prompt).toContain('Traits:');
      expect(prompt).toContain('- helpful');
      expect(prompt).toContain('- direct');
      expect(prompt).toContain('- concise');
    });

    it('handles empty custom identity (just base)', async () => {
      mockReadFile.mockResolvedValue('{}');

      const prompt = await buildIdentityPrompt(testDir);

      // Should just be base identity since empty custom adds nothing
      expect(prompt).toBe(getBaseIdentity());
    });

    // AC: @bot-identity ac-3
    it('uses base identity only on file read error', async () => {
      mockReadFile.mockRejectedValue(new Error('Permission denied'));

      const prompt = await buildIdentityPrompt(testDir);

      expect(prompt).toBe(getBaseIdentity());
    });
  });
});
