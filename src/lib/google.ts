import crypto from 'node:crypto';

/**
 * Minimal Google service-account auth, done by hand to avoid the googleapis/
 * gtoken transport bug ("Premature close" on the oauth2/v4/token endpoint via
 * undici on Render). We sign the JWT assertion with Node crypto and exchange it
 * for an access token using the same global fetch that works for every other
 * integration. Token is cached in-process until shortly before expiry.
 */
interface SaCreds {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const cache = new Map<string, { token: string; expEpochMs: number }>();

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signAssertion(creds: SaCreds, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(creds.private_key);
  return `${unsigned}.${b64url(signature)}`;
}

/** Get a cached/fresh OAuth access token for the given service-account JSON + scope. */
export async function getGoogleAccessToken(
  saJson: string,
  scope = 'https://www.googleapis.com/auth/drive',
): Promise<string> {
  const key = `${scope}`;
  const hit = cache.get(key);
  if (hit && hit.expEpochMs > Date.now() + 60_000) return hit.token;

  const creds = JSON.parse(saJson) as SaCreds;
  const assertion = signAssertion(creds, scope);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`google token exchange: ${res.status} ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as { access_token: string; expires_in?: number };
  cache.set(key, { token: data.access_token, expEpochMs: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

/** The service-account email a Drive folder must be shared with. */
export function googleClientEmail(saJson: string): string {
  return (JSON.parse(saJson) as SaCreds).client_email;
}
