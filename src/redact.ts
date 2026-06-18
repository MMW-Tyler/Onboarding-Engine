/**
 * Redaction helper (spec section 10): a single place that strips secrets before
 * anything is written to step_events. Never log tokens or passwords.
 *
 * Also enforces SENSITIVE_KEYS from spec section 11 - client PHI/credentials
 * (npi, dea, state_license, domain_credentials, website_credentials) must never
 * land in the open log.
 */

const SECRET_KEY_PATTERN =
  /(authorization|api[_-]?key|token|secret|password|passwd|pwd|bearer|client[_-]?secret|access[_-]?token|service[_-]?key)/i;

/** Spec section 11: sensitive client fields, routed to restricted storage, never logged. */
export const SENSITIVE_KEYS = new Set([
  'npi',
  'dea',
  'state_license',
  'domain_credentials',
  'website_credentials',
  'dns_credentials',
]);

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > MAX_DEPTH) return '[TRUNCATED]';

  if (typeof value === 'string') {
    return redactBearerInString(value);
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(k) || SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

/** Catch "Bearer xxx" / "Basic xxx" tokens embedded in free-text strings. */
function redactBearerInString(s: string): string {
  return s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+/gi, `$1 ${REDACTED}`);
}
