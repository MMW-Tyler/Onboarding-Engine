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
