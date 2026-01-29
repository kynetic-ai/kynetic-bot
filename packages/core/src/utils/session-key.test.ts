import { describe, it, expect } from 'vitest';
import {
  parseSessionKey,
  buildSessionKey,
  isValidSessionKey,
} from './session-key.js';
import { InvalidSessionKeyError } from './errors.js';
import type { ParsedSessionKey } from '../types/session-key.js';

describe('parseSessionKey', () => {
  it('should parse a valid session key with user peer', () => {
    const result = parseSessionKey('agent:main:whatsapp:user:+1234567890');
    expect(result).toEqual({
      agent: 'main',
      platform: 'whatsapp',
      peerKind: 'user',
      peerId: '+1234567890',
    });
  });

  it('should parse a valid session key with channel peer', () => {
    const result = parseSessionKey('agent:bot1:telegram:channel:@mychannel');
    expect(result).toEqual({
      agent: 'bot1',
      platform: 'telegram',
      peerKind: 'channel',
      peerId: '@mychannel',
    });
  });

  it('should parse peer IDs with colons', () => {
    const result = parseSessionKey('agent:main:discord:user:user:123:456');
    expect(result).toEqual({
      agent: 'main',
      platform: 'discord',
      peerKind: 'user',
      peerId: 'user:123:456',
    });
  });

  it('should throw InvalidSessionKeyError for missing agent prefix', () => {
    expect(() => parseSessionKey('main:whatsapp:user:+1234567890')).toThrow(
      InvalidSessionKeyError,
    );
  });

  it('should throw InvalidSessionKeyError for missing segments', () => {
    expect(() => parseSessionKey('agent:main:whatsapp')).toThrow(InvalidSessionKeyError);
  });

  it('should throw InvalidSessionKeyError for empty string', () => {
    expect(() => parseSessionKey('')).toThrow(InvalidSessionKeyError);
  });

  it('should throw InvalidSessionKeyError for invalid peer kind', () => {
    expect(() => parseSessionKey('agent:main:whatsapp:invalid:+1234567890')).toThrow(
      InvalidSessionKeyError,
    );
  });

  it('should throw InvalidSessionKeyError for empty agent', () => {
    expect(() => parseSessionKey('agent::whatsapp:user:+1234567890')).toThrow(
      InvalidSessionKeyError,
    );
  });

  it('should throw InvalidSessionKeyError for empty platform', () => {
    expect(() => parseSessionKey('agent:main::user:+1234567890')).toThrow(
      InvalidSessionKeyError,
    );
  });

  it('should throw InvalidSessionKeyError for empty peer ID', () => {
    expect(() => parseSessionKey('agent:main:whatsapp:user:')).toThrow(
      InvalidSessionKeyError,
    );
  });
});

describe('buildSessionKey', () => {
  it('should build a valid session key with user peer', () => {
    const parts: ParsedSessionKey = {
      agent: 'main',
      platform: 'whatsapp',
      peerKind: 'user',
      peerId: '+1234567890',
    };
    const result = buildSessionKey(parts);
    expect(result).toBe('agent:main:whatsapp:user:+1234567890');
  });

  it('should build a valid session key with channel peer', () => {
    const parts: ParsedSessionKey = {
      agent: 'bot1',
      platform: 'telegram',
      peerKind: 'channel',
      peerId: '@mychannel',
    };
    const result = buildSessionKey(parts);
    expect(result).toBe('agent:bot1:telegram:channel:@mychannel');
  });

  it('should handle peer IDs with special characters', () => {
    const parts: ParsedSessionKey = {
      agent: 'main',
      platform: 'discord',
      peerKind: 'user',
      peerId: 'user:123:456',
    };
    const result = buildSessionKey(parts);
    expect(result).toBe('agent:main:discord:user:user:123:456');
  });

  it('should throw error for missing agent', () => {
    const parts = {
      agent: '',
      platform: 'whatsapp',
      peerKind: 'user' as const,
      peerId: '+1234567890',
    };
    expect(() => buildSessionKey(parts)).toThrow();
  });

  it('should throw error for missing platform', () => {
    const parts = {
      agent: 'main',
      platform: '',
      peerKind: 'user' as const,
      peerId: '+1234567890',
    };
    expect(() => buildSessionKey(parts)).toThrow();
  });

  it('should throw error for missing peer ID', () => {
    const parts = {
      agent: 'main',
      platform: 'whatsapp',
      peerKind: 'user' as const,
      peerId: '',
    };
    expect(() => buildSessionKey(parts)).toThrow();
  });

  it('should throw error for invalid peer kind', () => {
    const parts = {
      agent: 'main',
      platform: 'whatsapp',
      peerKind: 'invalid' as 'user',  // Force incorrect type for testing
      peerId: '+1234567890',
    };
    expect(() => buildSessionKey(parts)).toThrow();
  });
});

describe('isValidSessionKey', () => {
  it('should return true for valid session key', () => {
    expect(isValidSessionKey('agent:main:whatsapp:user:+1234567890')).toBe(true);
  });

  it('should return false for invalid session key', () => {
    expect(isValidSessionKey('invalid')).toBe(false);
  });

  it('should return false for missing segments', () => {
    expect(isValidSessionKey('agent:main:whatsapp')).toBe(false);
  });

  it('should return false for empty string', () => {
    expect(isValidSessionKey('')).toBe(false);
  });
});

describe('parseSessionKey and buildSessionKey round-trip', () => {
  it('should round-trip correctly', () => {
    const original = 'agent:main:whatsapp:user:+1234567890';
    const parsed = parseSessionKey(original);
    const rebuilt = buildSessionKey(parsed);
    expect(rebuilt).toBe(original);
  });

  it('should round-trip with complex peer ID', () => {
    const original = 'agent:bot1:discord:channel:guild:123:channel:456';
    const parsed = parseSessionKey(original);
    const rebuilt = buildSessionKey(parsed);
    expect(rebuilt).toBe(original);
  });
});
