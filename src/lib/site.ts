/**
 * Fetching a client's website, the way it actually has to be done.
 *
 * Both crawlers (crawl.detect_platform in Wave 1, crawl.site_report in Wave 2)
 * used to do a single `fetch('https://' + host)` with a bot user-agent and no
 * status check. That fails on a large share of real practice sites:
 *
 *   - apex-only vs www-only: plenty of small practices have DNS (or a TLS cert)
 *     for www.example.com and nothing usable on the apex, so the one request we
 *     made died with ENOTFOUND / ERR_TLS_CERT_ALTNAME_INVALID;
 *   - http-only legacy sites: an https request to a host with no TLS listener
 *     just fails;
 *   - WAFs (Cloudflare, Sucuri, Wordfence) answer an obviously-scripted
 *     user-agent with a 403 challenge page. Without a status check that page was
 *     scored like real HTML, so the site came back "unknown" and looked like a
 *     detection failure rather than a blocked request.
 *
 * So: try the obvious host variants in order, send browser-shaped headers, and
 * report a specific reason when every variant fails, instead of a bare
 * "unreachable".
 */

/** Headers a normal browser sends. WAFs bounce requests that don't look like this. */
const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
};

/**
 * The URLs to try for a host, best first: https apex, https www, then the same
 * two over http for sites that never got a certificate. A host that already
 * carries a www (or any other) prefix keeps it as the first candidate.
 */
export function siteCandidates(host: string): string[] {
  const clean = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!clean || !clean.includes('.')) return [];
  const bare = clean.replace(/^www\./, '');
  const hasWww = clean.startsWith('www.');
  // Try the form the client gave us first; the other form is the fallback.
  const hosts = hasWww ? [clean, bare] : [bare, `www.${bare}`];
  return [...hosts.map((h) => `https://${h}`), ...hosts.map((h) => `http://${h}`)];
}

/**
 * Turn a fetch rejection into a short, actionable reason. undici nests the real
 * cause (DNS/TLS/socket codes) one level down, which is where the useful part is.
 */
export function failureReason(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'timeout';
  const code = String(
    (err as { cause?: { code?: string } } | undefined)?.cause?.code ??
      (err as { code?: string } | undefined)?.code ??
      '',
  ).toUpperCase();
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/.test(code)) return 'dns_error';
  if (/ECONNREFUSED/.test(code)) return 'connection_refused';
  if (/ECONNRESET|EPIPE/.test(code)) return 'connection_reset';
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(code)) return 'timeout';
  if (/CERT|TLS|SSL|ALTNAME/.test(code)) return 'tls_error';
  return code ? `fetch_error:${code.toLowerCase()}` : 'fetch_error';
}

export interface SiteAttempt {
  url: string;
  status?: number;
  error?: string;
}

export interface SiteFetch {
  ok: boolean;
  /** the URL that answered (post-redirect), or the last one tried */
  url: string;
  status: number | null;
  html: string;
  headers: Record<string, string>;
  /** why it failed, null when ok. e.g. dns_error, tls_error, http_403 */
  reason: string | null;
  /** every variant tried, in order - the log line that makes this debuggable */
  attempts: SiteAttempt[];
}

interface FetchOpts {
  timeoutMs?: number;
  maxBytes?: number;
}

/** GET one URL with browser headers and a hard timeout. Never throws. */
async function getOnce(
  url: string,
  { timeoutMs = 15_000, maxBytes = 400_000 }: FetchOpts = {},
): Promise<{ res: Response; html: string } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: BROWSER_HEADERS });
    const html = (await res.text()).slice(0, maxBytes);
    return { res, html };
  } catch (err) {
    return { error: failureReason(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a client's homepage, trying https/http and apex/www until one answers
 * with real HTML. Returns the first 2xx; if none of the variants gets there,
 * reports the most informative failure (an HTTP status beats a transport error,
 * since a 403 means the site is up and blocking us - a different problem with a
 * different fix than a domain that doesn't resolve).
 */
export async function fetchSite(host: string, opts: FetchOpts = {}): Promise<SiteFetch> {
  const candidates = siteCandidates(host);
  const attempts: SiteAttempt[] = [];
  let fallback: SiteFetch | null = null;

  for (const candidate of candidates) {
    const result = await getOnce(candidate, opts);
    if ('error' in result) {
      attempts.push({ url: candidate, error: result.error });
      continue;
    }
    const { res, html } = result;
    attempts.push({ url: candidate, status: res.status });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const hit: SiteFetch = {
      ok: res.ok && html.trim().length > 0,
      url: res.url || candidate,
      status: res.status,
      html,
      headers,
      reason: res.ok ? (html.trim().length === 0 ? 'empty_body' : null) : `http_${res.status}`,
      attempts,
    };
    if (hit.ok) return hit;
    // Keep the first real HTTP response as the reported failure - it says more
    // than "the www variant also didn't resolve".
    fallback ??= hit;
  }

  if (fallback) return { ...fallback, attempts };
  return {
    ok: false,
    url: candidates[0] ?? host,
    status: null,
    html: '',
    headers: {},
    reason: attempts[0]?.error ?? (candidates.length === 0 ? 'no_website' : 'unreachable'),
    attempts,
  };
}

/**
 * Fetch one additional page of a site already known to be reachable (the Wave 2
 * crawler walking internal links). No host laddering - the URL is already
 * absolute and came from the homepage.
 */
export async function fetchPage(url: string, opts: FetchOpts = {}): Promise<{ html: string } | null> {
  const result = await getOnce(url, opts);
  if ('error' in result) return null;
  if (!result.res.ok) return null;
  return { html: result.html };
}
