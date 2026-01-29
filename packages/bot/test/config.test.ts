/**
 * Bot Configuration Tests
 *
 * Tests for environment configuration loading and validation.
 *
 * @see @bot-config
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  BotConfigSchema,
  LogLevelSchema,
  loadConfig,
} from '../src/config.js';

describe('Bot Configuration', () => {
  describe('LogLevelSchema', () => {
    it('accepts valid log levels', () => {
      expect(LogLevelSchema.parse('debug')).toBe('debug');
      expect(LogLevelSchema.parse('info')).toBe('info');
      expect(LogLevelSchema.parse('warn')).toBe('warn');
      expect(LogLevelSchema.parse('error')).toBe('error');
    });

    // AC: @trait-validated ac-1 - invalid input returns structured error
    it('rejects invalid log levels with structured error', () => {
      const result = LogLevelSchema.safeParse('trace');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toBeDefined();
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });
  });

  describe('BotConfigSchema', () => {
    const validConfig = {
      discordToken: 'test-token-123',
      agentCommand: 'node agent.js',
    };

    // AC: @bot-config ac-1 - loads config with Zod validation
    it('validates required fields', () => {
      const result = BotConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.discordToken).toBe('test-token-123');
        expect(result.data.agentCommand).toBe('node agent.js');
      }
    });

    // AC: @bot-config ac-3 - uses sensible defaults for optional vars
    it('applies default values for optional fields', () => {
      const result = BotConfigSchema.parse(validConfig);
      expect(result.kbotDataDir).toBe('.kbot');
      expect(result.logLevel).toBe('info');
      expect(result.healthCheckInterval).toBe(30000);
      expect(result.shutdownTimeout).toBe(10000);
      expect(result.escalationChannel).toBeUndefined();
    });

    // AC: @bot-config ac-5 - includes escalationChannel when set
    it('includes escalationChannel when provided', () => {
      const configWithEscalation = {
        ...validConfig,
        escalationChannel: 'escalation-channel-id',
      };
      const result = BotConfigSchema.parse(configWithEscalation);
      expect(result.escalationChannel).toBe('escalation-channel-id');
    });

    // AC: @bot-config ac-2 - throws descriptive error for missing required var
    it('throws error when discordToken is missing', () => {
      const config = { agentCommand: 'node agent.js' };
      const result = BotConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('discordToken'))).toBe(true);
      }
    });

    // AC: @bot-config ac-2 - throws descriptive error for missing required var
    it('throws error when agentCommand is missing', () => {
      const config = { discordToken: 'test-token' };
      const result = BotConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('agentCommand'))).toBe(true);
      }
    });

    // AC: @bot-config ac-2 - identifies empty string as missing
    it('treats empty discordToken as missing', () => {
      const config = { discordToken: '', agentCommand: 'node agent.js' };
      const result = BotConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        const tokenIssue = result.error.issues.find((i) => i.path.includes('discordToken'));
        expect(tokenIssue?.message).toContain('DISCORD_TOKEN is required');
      }
    });

    // AC: @bot-config ac-2 - identifies empty string as missing
    it('treats empty agentCommand as missing', () => {
      const config = { discordToken: 'test-token', agentCommand: '' };
      const result = BotConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        const cmdIssue = result.error.issues.find((i) => i.path.includes('agentCommand'));
        expect(cmdIssue?.message).toContain('AGENT_COMMAND is required');
      }
    });

    // AC: @bot-config ac-4 - returns Zod error with path and expected type
    it('returns type error for invalid number format', () => {
      const config = {
        ...validConfig,
        healthCheckInterval: 'not-a-number',
      };
      const result = BotConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) =>
          i.path.includes('healthCheckInterval'),
        );
        expect(issue).toBeDefined();
        expect(issue?.code).toBe('invalid_type');
      }
    });

    // AC: @bot-config ac-4 - returns Zod error with path for invalid logLevel
    it('returns error with path for invalid logLevel', () => {
      const config = {
        ...validConfig,
        logLevel: 'invalid-level',
      };
      const result = BotConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) => i.path.includes('logLevel'));
        expect(issue).toBeDefined();
      }
    });

    // AC: @trait-validated ac-2 - identifies field in error
    it('identifies missing field in error message', () => {
      const result = BotConfigSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        // Should have errors for both required fields
        expect(result.error.issues.some((i) => i.path.includes('discordToken'))).toBe(true);
        expect(result.error.issues.some((i) => i.path.includes('agentCommand'))).toBe(true);
      }
    });

    // AC: @trait-validated ac-3 - includes expected type in error
    it('includes expected type in validation error', () => {
      const config = {
        ...validConfig,
        shutdownTimeout: 'invalid',
      };
      const result = BotConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) =>
          i.path.includes('shutdownTimeout'),
        );
        expect(issue?.code).toBe('invalid_type');
        expect(issue?.expected).toBe('number');
      }
    });

    it('rejects negative numbers for healthCheckInterval', () => {
      const config = {
        ...validConfig,
        healthCheckInterval: -1,
      };
      const result = BotConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('rejects negative numbers for shutdownTimeout', () => {
      const config = {
        ...validConfig,
        shutdownTimeout: -100,
      };
      const result = BotConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('rejects non-integer numbers for healthCheckInterval', () => {
      const config = {
        ...validConfig,
        healthCheckInterval: 30000.5,
      };
      const result = BotConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('accepts all optional fields with custom values', () => {
      const fullConfig = {
        ...validConfig,
        kbotDataDir: '/custom/data',
        logLevel: 'debug',
        healthCheckInterval: 60000,
        shutdownTimeout: 5000,
        escalationChannel: 'channel-123',
      };
      const result = BotConfigSchema.parse(fullConfig);
      expect(result.kbotDataDir).toBe('/custom/data');
      expect(result.logLevel).toBe('debug');
      expect(result.healthCheckInterval).toBe(60000);
      expect(result.shutdownTimeout).toBe(5000);
      expect(result.escalationChannel).toBe('channel-123');
    });
  });

  describe('loadConfig', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Reset environment for each test
      process.env = { ...originalEnv };
      // Clear relevant env vars
      delete process.env.DISCORD_TOKEN;
      delete process.env.AGENT_COMMAND;
      delete process.env.KBOT_DATA_DIR;
      delete process.env.LOG_LEVEL;
      delete process.env.HEALTH_CHECK_INTERVAL;
      delete process.env.SHUTDOWN_TIMEOUT;
      delete process.env.ESCALATION_CHANNEL;
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    // AC: @bot-config ac-1 - loads config from environment variables
    it('loads config from environment variables', () => {
      process.env.DISCORD_TOKEN = 'env-token';
      process.env.AGENT_COMMAND = 'env-command';

      const config = loadConfig();
      expect(config.discordToken).toBe('env-token');
      expect(config.agentCommand).toBe('env-command');
    });

    // AC: @bot-config ac-1 - loads all fields from environment
    it('loads all environment variables', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.KBOT_DATA_DIR = '/custom/dir';
      process.env.LOG_LEVEL = 'debug';
      process.env.HEALTH_CHECK_INTERVAL = '45000';
      process.env.SHUTDOWN_TIMEOUT = '15000';
      process.env.ESCALATION_CHANNEL = 'escalation-ch';

      const config = loadConfig();
      expect(config.discordToken).toBe('test-token');
      expect(config.agentCommand).toBe('test-command');
      expect(config.kbotDataDir).toBe('/custom/dir');
      expect(config.logLevel).toBe('debug');
      expect(config.healthCheckInterval).toBe(45000);
      expect(config.shutdownTimeout).toBe(15000);
      expect(config.escalationChannel).toBe('escalation-ch');
    });

    // AC: @bot-config ac-2 - throws descriptive error for missing required var
    it('throws ZodError when DISCORD_TOKEN is missing', () => {
      process.env.AGENT_COMMAND = 'some-command';

      expect(() => loadConfig()).toThrow(ZodError);
      try {
        loadConfig();
      } catch (error) {
        expect(error).toBeInstanceOf(ZodError);
        const zodError = error as ZodError;
        expect(zodError.issues.some((i) => i.path.includes('discordToken'))).toBe(true);
      }
    });

    // AC: @bot-config ac-2 - throws descriptive error for missing required var
    it('throws ZodError when AGENT_COMMAND is missing', () => {
      process.env.DISCORD_TOKEN = 'some-token';

      expect(() => loadConfig()).toThrow(ZodError);
      try {
        loadConfig();
      } catch (error) {
        expect(error).toBeInstanceOf(ZodError);
        const zodError = error as ZodError;
        expect(zodError.issues.some((i) => i.path.includes('agentCommand'))).toBe(true);
      }
    });

    // AC: @bot-config ac-3 - uses sensible defaults
    it('uses default values when optional vars not set', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';

      const config = loadConfig();
      expect(config.kbotDataDir).toBe('.kbot');
      expect(config.logLevel).toBe('info');
      expect(config.healthCheckInterval).toBe(30000);
      expect(config.shutdownTimeout).toBe(10000);
      expect(config.escalationChannel).toBeUndefined();
    });

    // AC: @bot-config ac-4 - throws error for invalid number format
    it('throws error for invalid HEALTH_CHECK_INTERVAL format', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.HEALTH_CHECK_INTERVAL = 'not-a-number';

      expect(() => loadConfig()).toThrow('Invalid integer for HEALTH_CHECK_INTERVAL');
    });

    // AC: @bot-config ac-4 - throws error for invalid number format
    it('throws error for HEALTH_CHECK_INTERVAL with units suffix', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.HEALTH_CHECK_INTERVAL = '30s';

      expect(() => loadConfig()).toThrow('Invalid integer for HEALTH_CHECK_INTERVAL');
    });

    // AC: @bot-config ac-4 - throws error for invalid number format
    it('throws error for invalid SHUTDOWN_TIMEOUT format', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.SHUTDOWN_TIMEOUT = '10sec';

      expect(() => loadConfig()).toThrow('Invalid integer for SHUTDOWN_TIMEOUT');
    });

    // AC: @bot-config ac-4 - validates log level
    it('throws error for invalid LOG_LEVEL', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.LOG_LEVEL = 'invalid';

      expect(() => loadConfig()).toThrow(ZodError);
    });

    // AC: @bot-config ac-5 - loads ESCALATION_CHANNEL
    it('loads ESCALATION_CHANNEL environment variable', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.ESCALATION_CHANNEL = 'my-escalation-channel';

      const config = loadConfig();
      expect(config.escalationChannel).toBe('my-escalation-channel');
    });

    // AC: @bot-config ac-5 - escalationChannel is optional
    it('escalationChannel is undefined when not set', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';

      const config = loadConfig();
      expect(config.escalationChannel).toBeUndefined();
    });

    it('handles empty string environment variables as not set', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.KBOT_DATA_DIR = '';
      process.env.LOG_LEVEL = '';
      process.env.ESCALATION_CHANNEL = '';

      const config = loadConfig();
      expect(config.kbotDataDir).toBe('.kbot'); // Default
      expect(config.logLevel).toBe('info'); // Default
      expect(config.escalationChannel).toBeUndefined();
    });

    it('parses numeric environment variables correctly', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.HEALTH_CHECK_INTERVAL = '60000';
      process.env.SHUTDOWN_TIMEOUT = '5000';

      const config = loadConfig();
      expect(config.healthCheckInterval).toBe(60000);
      expect(config.shutdownTimeout).toBe(5000);
    });

    it('rejects zero values for numeric fields (must be positive)', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.HEALTH_CHECK_INTERVAL = '0';

      expect(() => loadConfig()).toThrow(ZodError);
    });

    it('accepts numeric values with whitespace', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.HEALTH_CHECK_INTERVAL = ' 45000 ';

      // Whitespace around numbers should be handled (trimmed)
      const config = loadConfig();
      expect(config.healthCheckInterval).toBe(45000);
    });

    it('rejects decimal numbers in environment variables', () => {
      process.env.DISCORD_TOKEN = 'test-token';
      process.env.AGENT_COMMAND = 'test-command';
      process.env.HEALTH_CHECK_INTERVAL = '30000.5';

      expect(() => loadConfig()).toThrow('Invalid integer for HEALTH_CHECK_INTERVAL');
    });
  });
});
