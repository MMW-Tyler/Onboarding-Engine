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
 * Consumer mailbox providers. A value pointing at one of these is never the
 * practice's own website - it's a personal email address that landed in the
 * website question. Used to reject the host outright instead of treating
 * "drjane@gmail.com" as the site (which would make the domain steps derive
 * their base label from "gmail" and try to buy gmailpx.com).
 */
const FREE_EMAIL_HOSTS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'aol.com', 'aim.com',
  'icloud.com', 'me.com', 'mac.com',
  'comcast.net', 'sbcglobal.net', 'att.net', 'verizon.net', 'bellsouth.net',
  'cox.net', 'charter.net', 'earthlink.net', 'roadrunner.com', 'rr.com',
  'optonline.net', 'pacbell.net', 'embarqmail.com', 'windstream.net',
  'frontier.com', 'juno.com',
  'protonmail.com', 'proton.me', 'gmx.com', 'gmx.net', 'mail.com',
  'yandex.com', 'zoho.com', 'hushmail.com', 'inbox.com',
]);

/** True for hosts that belong to a consumer mailbox provider, never a practice site. */
export function isFreeEmailHost(value: string): boolean {
  return FREE_EMAIL_HOSTS.has(toHost(value));
}

/** Matches an email address anywhere in a free-text answer; group 1 is its host. */
const EMAIL_TOKEN =
  /(?:mailto:)?[a-z0-9._%+'-]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,})/gi;

export type WebsiteReason =
  /** the value was already a usable domain */
  | null
  /** an email was typed alongside a real site; the site won */
  | 'email_stripped'
  /** the whole answer was a work email - its host is the practice domain */
  | 'email_domain'
  /** the answer pointed at a personal mailbox (gmail/yahoo/...) - unusable */
  | 'free_email'
  /** nothing domain-shaped in the answer at all */
  | 'not_a_domain';

export interface WebsiteValue {
  /** the practice host, or null when the answer can't yield one */
  host: string | null;
  /** what had to be done to get there, for logging + human review */
  reason: WebsiteReason;
}

/**
 * Resolve a free-text "website" answer to the practice's host.
 *
 * Reps and clients routinely put an email address in the website question
 * (real case: an @-address typed into the Sales Intake form's Website URL
 * field). A raw email poisons everything downstream - it isn't a domain, so
 * run.domain stays empty and the DNS/Mailgun/warmup steps fail, while the
 * domain-purchase step's URL parse quietly reads the part after the @ as the
 * base label. So: prefer a real site typed anywhere in the answer, otherwise
 * fall back to the email's host when it's a work address (which IS the
 * practice's domain), and refuse consumer mailbox hosts outright.
 */
export function websiteHostFrom(raw: string | null | undefined): WebsiteValue {
  const value = (raw ?? '').trim();
  if (!value) return { host: null, reason: 'not_a_domain' };

  // Pull out every email first so the rest of the answer can be scanned for a
  // real site without the email's host masquerading as one.
  const emailHosts: string[] = [];
  const withoutEmails = value.replace(EMAIL_TOKEN, (_match, host: string) => {
    emailHosts.push(host.toLowerCase());
    return ' ';
  });

  const direct = looksLikeDomain(withoutEmails) ? toHost(withoutEmails) : firstDomainToken(withoutEmails);
  if (direct && !isFreeEmailHost(direct)) {
    return { host: direct, reason: emailHosts.length > 0 ? 'email_stripped' : null };
  }
  if (direct) return { host: null, reason: 'free_email' }; // bare "gmail.com" etc.

  if (emailHosts.length === 0) return { host: null, reason: 'not_a_domain' };
  const mailHost = toHost(emailHosts[0]!);
  if (isFreeEmailHost(mailHost)) return { host: null, reason: 'free_email' };
  return { host: mailHost, reason: 'email_domain' };
}

/**
 * Extract the practice's website domain from a raw webhook form payload.
 * Looks only at the "website" question (not any label merely containing
 * "url", which would also match social-profile questions) and scans the cell
 * for a domain-shaped token so a compound or annotated answer still resolves.
 * An answer that is really an email address resolves to that address's host
 * (see websiteHostFrom), so a Wave 2 form filled in the same sloppy way as
 * Wave 1 still matches its run. Used by both the webhook route and the offline
 * CSV replay harness so they stay in sync (see scripts/).
 */
export function extractWebsiteDomain(body: Record<string, unknown>): string | null {
  for (const [label, value] of Object.entries(body)) {
    if (!/website/i.test(label)) continue;
    if (typeof value !== 'string') continue;
    const { host } = websiteHostFrom(value);
    if (host) return host;
  }
  return null;
}
