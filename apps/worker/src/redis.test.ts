import { describe, expect, it } from 'vitest';
import { RedisConfigError, parseBullMqConnectionOptions, sanitizeRedisTarget } from './redis.js';

describe('parseBullMqConnectionOptions and sanitizeRedisTarget', () => {
  it('parses plain redis:// URLs using the explicit port and omits tls', () => {
    const config = parseBullMqConnectionOptions('redis://127.0.0.1:6380');

    expect(config).toEqual({
      host: '127.0.0.1',
      port: 6380,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    expect('tls' in config).toBe(false);
    expect('username' in config).toBe(false);
    expect('password' in config).toBe(false);
  });

  it('falls back to port 6379 only when omitted, enables tls for rediss://, decodes credentials, and parses db index', () => {
    const config = parseBullMqConnectionOptions(
      'rediss://default:p%40ss%3Aword@upstash.example.io/2',
    );

    expect(config).toEqual({
      host: 'upstash.example.io',
      port: 6379,
      username: 'default',
      password: 'p@ss:word',
      db: 2,
      tls: {},
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  });

  it('rejects non-redis protocols, empty strings, invalid ports, and invalid db paths with RedisConfigError', () => {
    const badUrls = [
      '',
      '   ',
      'http://127.0.0.1:6380',
      'postgresql://user:pass@127.0.0.1:5432/archon',
      'redis://127.0.0.1:6380/not-a-db',
      'redis://127.0.0.1:6380/1/2',
      'redis://:pass@127.0.0.1:6380/%ZZ',
      'not-a-url',
    ];

    for (const url of badUrls) {
      expect(() => parseBullMqConnectionOptions(url), `Expected error for ${url}`).toThrow(
        RedisConfigError,
      );
    }
  });

  it('sanitizes Redis URLs to host:port and never leaks username or password', () => {
    const secretUrl = 'rediss://admin_user:super_secret_redis_pw@cool-redis.upstash.io:6399/3';
    const sanitized = sanitizeRedisTarget(secretUrl);

    expect(sanitized).toBe('cool-redis.upstash.io:6399');
    expect(sanitized).not.toContain('admin_user');
    expect(sanitized).not.toContain('super_secret_redis_pw');

    expect(sanitizeRedisTarget('http://bad.example.com')).toBe('<invalid-redis-url>');
  });
});
