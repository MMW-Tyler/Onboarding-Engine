import { config } from '../config.js';

/**
 * Build a Namecheap XML API URL for a command + extra params.
 *
 * IP whitelist workaround: Namecheap requires API calls to originate from a
 * whitelisted IP, but Render's outbound IPs are shared/rotating. When
 * NAMECHEAP_RELAY_URL is set, we route the call through a static-IP egress relay
 * (a small script on a host you control, e.g. one of your web servers - see
 * scripts/namecheap-relay.php). The relay forwards the query to Namecheap from
 * its own whitelisted IP and returns the XML verbatim, so the engine doesn't
 * need a static IP of its own. ClientIp is set to NAMECHEAP_CLIENT_IP, which you
 * set to the relay host's whitelisted IP.
 *
 * With no relay configured, calls go directly to NAMECHEAP_BASE_URL (sandbox by
 * default) - fine for local/dev where the machine's IP is whitelisted.
 */
/**
 * Unwrap a relay response that JSON-encoded the XML. The WordPress relay returns
 * the Namecheap XML via WP_REST_Response, which serializes the body as a JSON
 * string (escaping every "). That turns Available="true" into Available=\"true\",
 * which breaks the attribute regexes. If the body is a JSON-encoded string,
 * decode it back to raw XML; otherwise return it unchanged (the standalone PHP
 * relay and direct calls already return raw XML).
 */
export function unwrapRelayXml(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try {
      const decoded = JSON.parse(t);
      if (typeof decoded === 'string') return decoded;
    } catch {
      // not valid JSON - fall through and return as-is
    }
  }
  return raw;
}

export function namecheapUrl(command: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    ApiUser: config.namecheap.apiUser(),
    ApiKey: config.namecheap.apiKey(),
    UserName: config.namecheap.apiUser(),
    ClientIp: config.namecheap.clientIp(),
    Command: command,
    ...extra,
  });

  const relay = config.namecheap.relayUrl();
  if (relay) {
    const sep = relay.includes('?') ? '&' : '?';
    const env = config.namecheap.live ? 'live' : 'sandbox';
    return `${relay}${sep}s=${encodeURIComponent(config.namecheap.relaySecret())}&env=${env}&${params.toString()}`;
  }
  return `${config.namecheap.baseUrl}/xml.response?${params.toString()}`;
}
