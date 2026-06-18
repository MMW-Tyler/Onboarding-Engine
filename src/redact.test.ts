import { describe, it, expect } from 'vitest';
import { redact, SENSITIVE_KEYS } from './redact.js';

describe('redact', () => {
  it('masks secret-looking keys', () => {
    const out = redact({ api_key: 'abc123', Authorization: 'Bearer xyz', name: 'Acme' }) as Record<string, unknown>;
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.name).toBe('Acme');
  });

  it('masks sensitive client keys (spec section 11)', () => {
    for (const key of SENSITIVE_KEYS) {
      const out = redact({ [key]: 'value' }) as Record<string, unknown>;
      expect(out[key]).toBe('[REDACTED]');
    }
  });

  it('recurses into nested objects and arrays', () => {
    const out = redact({ outer: { token: 't', items: [{ password: 'p', ok: 1 }] } }) as any;
    expect(out.outer.token).toBe('[REDACTED]');
    expect(out.outer.items[0].password).toBe('[REDACTED]');
    expect(out.outer.items[0].ok).toBe(1);
  });

  it('masks bearer tokens embedded in strings', () => {
    expect(redact('Authorization: Bearer secret-token-123')).toContain('[REDACTED]');
  });

  it('passes through primitives', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });
});
