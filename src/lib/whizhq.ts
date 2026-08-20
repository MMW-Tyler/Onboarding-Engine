import type { StepContext } from '../types.js';
import { config } from '../config.js';
import { callApi, HttpError } from './http.js';

/**
 * WhizHQ automation client (the `mmw-platform` app: Node/Express on Render,
 * Supabase behind it). HTTP only - the two systems share nothing else, and the
 * integration spec forbids touching WhizHQ's database or logging in as a user,
 * because every invariant it has (context provenance, portal share links,
 * onboarding step state) lives in its application code.
 *
 * Every automation route sits outside WhizHQ's session middleware and is gated
 * on one header, `X-Automation-Key`. Redaction covers it: `automation[_-]?key`
 * is in redact.ts's SECRET_KEY_PATTERN, so the header never reaches step_events.
 */

/** Where a WhizHQ call landed, in the terms the steps actually branch on. */
export type WhizFailureKind =
  /** The route isn't there (not deployed) or WhizHQ has no AUTOMATION_KEY set. */
  | 'not_deployed'
  /** 401: our key is wrong or missing. A config bug; retrying cannot help. */
  | 'auth'
  /** 400: WhizHQ rejected the payload. Nothing was created; safe to fix + retry. */
  | 'bad_request'
  /** 404 from the API itself: the client id we sent does not exist. */
  | 'not_found'
  /** 409: a crawl is already running for this client. Nothing was started. */
  | 'conflict'
  /**
   * 5xx, a network error, or a timeout. AMBIGUOUS - the write may have landed.
   * `clients/onboard` must never be blind-retried on this (see WHIZ_AMBIGUOUS).
   */
  | 'server';

export interface WhizFailure {
  kind: WhizFailureKind;
  /** Human-readable, safe to put in last_error / a Slack line. */
  message: string;
  status: number;
  body: unknown;
}

/**
 * Classify an HttpError from a WhizHQ call.
 *
 * The only subtle case is 404, which means two completely different things:
 * an un-deployed route (Express answers its own HTML "Cannot POST /api/...")
 * versus the API answering `{"error":"..."}` about a client id it doesn't know.
 * The first is "skip and carry on", the second is a real bug in what we sent, so
 * they are told apart by whether the body is JSON with an `error` string.
 */
export function classifyWhizError(err: unknown): WhizFailure {
  if (!(err instanceof HttpError)) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'server', message, status: 0, body: null };
  }
  const status = err.status;
  const body = err.body;
  const apiMessage = apiErrorOf(body);
  const message = apiMessage ?? err.message;

  if (status === 401) return { kind: 'auth', message, status, body };
  if (status === 503) return { kind: 'not_deployed', message, status, body };
  if (status === 409) return { kind: 'conflict', message, status, body };
  if (status === 400) return { kind: 'bad_request', message, status, body };
  if (status === 404) {
    return apiMessage
      ? { kind: 'not_found', message: apiMessage, status, body }
      : { kind: 'not_deployed', message: 'route not found on WhizHQ (not deployed yet)', status, body };
  }
  return { kind: 'server', message, status, body };
}

/** The `error` string from a WhizHQ JSON error body, when there is one. */
function apiErrorOf(body: unknown): string | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === 'string' && e.trim()) return e.trim();
  }
  return null;
}

/**
 * Failure kinds that mean "WhizHQ isn't listening yet" rather than "something
 * went wrong". `site-intelligence/bootstrap` and the portal routes were built
 * but await a deploy plus migration 045, so until Tyler confirms both, the steps
 * that call them must log and skip rather than fail a run.
 */
export const WHIZ_SKIPPABLE: ReadonlySet<WhizFailureKind> = new Set<WhizFailureKind>(['not_deployed']);

/**
 * Failure kinds after which we cannot know whether the write landed. Fatal for
 * `clients/onboard`: a blind retry risks a second client record, and WhizHQ
 * names are not unique, so a duplicate splits one client's work across two
 * records. A human looks WhizHQ up instead.
 */
export const WHIZ_AMBIGUOUS: ReadonlySet<WhizFailureKind> = new Set<WhizFailureKind>(['server']);

/** True when WHIZHQ_BASE_URL + WHIZHQ_AUTOMATION_KEY are both set. */
export function whizhqConfigured(): boolean {
  return config.whizhq.configured();
}

/**
 * One WhizHQ automation call, logged to step_events like every other external
 * call in the engine. 30s timeout: nothing on this API is long-lived (the crawl
 * returns as soon as it is queued and is polled separately).
 */
export async function whizCall<T = any>(
  ctx: StepContext,
  path: string,
  label: string,
  opts: { method?: string; json?: unknown; okStatuses?: number[] } = {},
): Promise<T> {
  const base = config.whizhq.baseUrl();
  if (!base) throw new Error('whizhq: WHIZHQ_BASE_URL is not set');
  const res = await callApi<T>(ctx, `${base}${path}`, label, {
    method: opts.method ?? 'GET',
    headers: { 'x-automation-key': config.whizhq.automationKey() },
    json: opts.json,
    okStatuses: opts.okStatuses,
    timeoutMs: 30_000,
  });
  return res.body;
}

// --- payloads -------------------------------------------------------------

export interface WhizOnboardRequest {
  name: string;
  domain?: string;
  vertical?: string;
  client_type: 'standard' | 'temporary';
  program?: string | null;
  slack_channel?: string;
  ae_email?: string;
}

export interface WhizOnboardResponse {
  ok?: boolean;
  clientId?: string;
  portalUrl?: string;
  onboardingUrl?: string | null;
  onboarding?: { programKey?: string; total?: number } | null;
  slackMapped?: boolean;
  aeAssigned?: boolean;
}

export interface WhizBootstrapResponse {
  ok?: boolean;
  clientId?: string;
  crawlId?: string;
  targetUrl?: string;
  statusUrl?: string;
}

/** One of WhizHQ's two autofill steps in a poll response. */
export interface WhizAutofillStep {
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  applied: string[];
  skipped: { field: string; reason: string }[];
  notes: string[];
  pagesAnalyzed: number | null;
  error: string | null;
}

export interface WhizPoll {
  ok?: boolean;
  clientId?: string;
  portalUrl?: string;
  crawl?: {
    id?: string;
    /** WhizHQ's own vocabulary: `done` is the success case, not `complete`. */
    status?: 'running' | 'done' | 'error' | 'cancelled';
    /** True only while a process is actually working on this crawl. */
    live?: boolean;
    targetUrl?: string;
    pageCount?: number;
    errorCount?: number;
    avgWordCount?: number;
    startedAt?: string;
    finishedAt?: string;
    error?: string | null;
  };
  clientInfo?: WhizAutofillStep;
  brandVoice?: WhizAutofillStep;
  requestedAt?: string;
  updatedAt?: string;
}

// --- poll interpretation (pure, unit-tested) ------------------------------

const IN_FLIGHT = new Set(['pending', 'running']);

/**
 * The run is finished when the crawl is no longer running AND neither autofill
 * step is still pending or running. A missing step object counts as finished:
 * WhizHQ always sends both, so an absent one means an older shape we should not
 * wait forever on.
 */
export function bootstrapFinished(poll: WhizPoll): boolean {
  if (poll.crawl?.status === 'running') return false;
  for (const step of [poll.clientInfo, poll.brandVoice]) {
    if (step?.status && IN_FLIGHT.has(step.status)) return false;
  }
  return true;
}

/**
 * A crawl that says `running` with no live job behind it is dead: WhizHQ runs
 * crawls inside its web process with in-memory job state, so a Render deploy
 * mid-crawl kills the run and leaves the row saying `running` forever.
 *
 * `live` alone is not a "still going" test in either direction - finished jobs
 * stay live for ~10 minutes after they end, and a just-queued crawl may not have
 * registered a live job yet. Hence `minPolls`: only trust `live: false` after a
 * couple of polls, so a fresh bootstrap is never declared dead on arrival.
 */
export function isDeadCrawl(poll: WhizPoll, attempt: number, minPolls = 3): boolean {
  return poll.crawl?.status === 'running' && poll.crawl?.live === false && attempt >= minPolls;
}

/** Did the crawl itself fail (a blocked host reads zero pages and errors)? */
export function crawlFailed(poll: WhizPoll): boolean {
  return poll.crawl?.status === 'error' || poll.crawl?.status === 'cancelled';
}

export interface BootstrapSummary {
  /** One-line headline for the Slack thread reply. */
  headline: string;
  /** Supporting lines: what got filled, what was skipped, what failed. */
  detail: string[];
  /** Machine-readable roll-up for the step's output_json. */
  facts: Record<string, unknown>;
}

/**
 * Turn a finished poll into the thread reply the engine posts under its Wave 1
 * roll-up, plus the facts worth keeping on the step.
 *
 * Deliberately explicit that the values are unverified: WhizHQ writes them with
 * source `crawl` / `analyzer` and they stay unverified until a human saves the
 * Clients form. They must never be presented to a client as confirmed practice
 * details, and the client's own onboarding-form answers overwrite them later.
 */
export function summarizeBootstrap(poll: WhizPoll, host: string): BootstrapSummary {
  const crawl = poll.crawl ?? {};
  const target = crawl.targetUrl ?? host;
  const info = poll.clientInfo;
  const voice = poll.brandVoice;
  const detail: string[] = [];

  if (crawlFailed(poll)) {
    return {
      headline: `⚠️ WhizHQ could not crawl ${target} (${crawl.status}${crawl.error ? `: ${crawl.error}` : ''}).`,
      detail: [
        'Nothing was filled in. Some hosts block the platform\'s IP; a crawl that reads zero pages fails rather than finishing.',
        'The client info and brand voice fields are still empty - fill them from the onboarding form or by hand.',
      ],
      facts: { crawl_status: crawl.status ?? 'error', crawl_error: crawl.error ?? null, pages: crawl.pageCount ?? 0 },
    };
  }

  const pages = crawl.pageCount ?? 0;
  const headline = `🔍 WhizHQ crawled ${pages} page${pages === 1 ? '' : 's'} of ${target}.`;

  const applied = info?.applied ?? [];
  if (info?.status === 'complete' && applied.length > 0) {
    detail.push(`• Filled from the site: ${applied.join(', ')}.`);
  } else if (info?.status === 'complete') {
    detail.push('• Client info: nothing to fill - every field it reads was already set.');
  } else if (info?.status === 'skipped') {
    detail.push('• Client info: skipped.');
  } else if (info?.status === 'failed') {
    detail.push(`• Client info autofill failed${info.error ? `: ${info.error}` : ''}.`);
  }

  const skippedFields = info?.skipped ?? [];
  if (skippedFields.length > 0) {
    detail.push(`• Left alone (already filled in): ${skippedFields.map((s) => s.field).join(', ')}.`);
  }

  if (voice?.status === 'complete') {
    const from = voice.pagesAnalyzed ? ` from ${voice.pagesAnalyzed} content pages` : '';
    detail.push(`• Brand voice profile written${from}.`);
  } else if (voice?.status === 'failed') {
    detail.push(`• Brand voice generation failed${voice.error ? `: ${voice.error}` : ''}.`);
  } else if (voice?.status === 'skipped') {
    detail.push('• Brand voice: skipped.');
  }

  for (const note of [...(info?.notes ?? []), ...(voice?.notes ?? [])]) detail.push(`• ${note}`);

  if (crawl.errorCount) detail.push(`• ${crawl.errorCount} page${crawl.errorCount === 1 ? '' : 's'} errored during the crawl.`);

  if (applied.length > 0 || voice?.status === 'complete') {
    detail.push('_All of it is unverified - confirm it in the client profile. The client\'s own onboarding-form answers overwrite it._');
  }

  return {
    headline,
    detail,
    facts: {
      crawl_status: crawl.status ?? 'unknown',
      pages,
      page_errors: crawl.errorCount ?? 0,
      client_info_status: info?.status ?? 'unknown',
      client_info_applied: applied,
      brand_voice_status: voice?.status ?? 'unknown',
      brand_voice_pages: voice?.pagesAnalyzed ?? null,
    },
  };
}

/** Short "still waiting" line for the poll's last_error, so the log reads as progress. */
export function pollProgressLine(poll: WhizPoll, attempt: number, maxAttempts: number): string {
  const crawl = poll.crawl ?? {};
  const parts = [`crawl ${crawl.status ?? 'unknown'}`];
  if (crawl.pageCount != null) parts.push(`${crawl.pageCount} pages`);
  if (poll.clientInfo?.status) parts.push(`client info ${poll.clientInfo.status}`);
  if (poll.brandVoice?.status) parts.push(`brand voice ${poll.brandVoice.status}`);
  return `waiting on WhizHQ (${parts.join(', ')}) - poll ${attempt}/${maxAttempts}`;
}
