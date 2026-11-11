/**
 * Redaction helper (spec section 10): a single place that strips secrets before
 * anything is written to step_events. Never log tokens or passwords.
 *
 * Also enforces SENSITIVE_KEYS from spec section 11 - client PHI/credentials
 * (npi, dea, state_license, domain_credentials, website_credentials) must never
 * land in the open log.
 */

const SECRET_KEY_PATTERN =
  /(authorization|api[_-]?key|automation[_-]?key|token|secret|password|passwd|pwd|bearer|client[_-]?secret|access[_-]?token|service[_-]?key)/i;

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

/**
 * Query-string parameters that carry a credential. Namecheap takes its API key
 * as `ApiKey=` and the relay takes its shared secret as `s=`, both in the URL,
 * and the URL is logged with every call. Key-name redaction never saw them
 * (the key is "url"), so 184 log rows written before 2026-11-11 hold both in
 * clear. `s` is only treated as a secret right after `?` or `&`.
 */
const SECRET_QUERY_PARAM =
  /([?&](?:api[_-]?key|apikey|key|token|access[_-]?token|secret|password|pwd|sig|signature|s)=)[^&#\s"']+/gi;

/** Catch "Bearer xxx" / "Basic xxx" tokens and secret URL parameters in strings. */
function redactBearerInString(s: string): string {
  return s
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._\-+/=]+/gi, `$1 ${REDACTED}`)
    .replace(SECRET_QUERY_PARAM, `$1${REDACTED}`);
}
