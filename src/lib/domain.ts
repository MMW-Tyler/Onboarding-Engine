/**
 * Reduce a messy user-entered website value to a bare host.
 * Tolerant of clients filling forms imperfectly: handles missing/extra scheme,
 * www., trailing slashes, paths, query strings, casing, and stray whitespace.
 *   "https://www.Foo.com/contact?x=1" -> "foo.com"
 *   "  WWW.Foo.Com "                  -> "foo.com"
 *   "foo.com"                         -> "foo.com"
 */
export function toHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]!
    .trim();
}

/** True only if the value reduces to something that looks like a real domain. */
export function looksLikeDomain(value: string): boolean {
  const host = toHost(value);
  // at least name.tld, no spaces, valid-ish characters
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host);
}

/**
 * Pull the first domain-looking token out of a free-text cell. Clients often
 * answer the website question with more than a bare URL - multiple domains
 * ("www.foo.com [practice] www.bar.com [product]"), trailing labels, or
 * commentary - so unlike looksLikeDomain (which requires the *whole* trimmed
 * value to be a domain), this scans for a domain-shaped substring anywhere in
 * the text and returns the first one found.
 */
const DOMAIN_TOKEN = /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,})\b/i;

export function firstDomainToken(value: string): string | null {
  const cleaned = value.toLowerCase().replace(/^https?:\/\//, '');
  const m = cleaned.match(DOMAIN_TOKEN);
  if (!m) return null;
  const host = toHost(m[1]!);
  return looksLikeDomain(host) ? host : null;
}

/**
 * Extract the practice's website domain from a raw webhook form payload.
 * Looks only at the "website" question (not any label merely containing
 * "url", which would also match social-profile questions) and scans the cell
 * for a domain-shaped token so a compound or annotated answer still resolves.
 * Used by both the webhook route and the offline CSV replay harness so they
 * stay in sync (see scripts/).
 */
export function extractWebsiteDomain(body: Record<string, unknown>): string | null {
  for (const [label, value] of Object.entries(body)) {
    if (!/website/i.test(label)) continue;
    if (typeof value !== 'string') continue;
    const direct = looksLikeDomain(value) ? toHost(value) : firstDomainToken(value);
    if (direct) return direct;
  }
  return null;
}
