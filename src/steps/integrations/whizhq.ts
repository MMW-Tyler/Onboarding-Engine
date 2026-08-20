import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { config } from '../../config.js';
import { profileOf, siblingOutput, simId, simulated } from './util.js';
import { clientSiteHost } from './crawl.js';
import { slackPost } from './slack.js';
import {
  bootstrapFinished,
  classifyWhizError,
  clientTypeFor,
  crawlFailed,
  isDeadCrawl,
  pollProgressLine,
  summarizeBootstrap,
  whizCall,
  whizhqConfigured,
  WHIZ_AMBIGUOUS,
  WHIZ_SKIPPABLE,
  type WhizBootstrapResponse,
  type WhizOnboardRequest,
  type WhizOnboardResponse,
  type WhizPoll,
} from '../../lib/whizhq.js';

/**
 * WhizHQ workers: hand the client off to the platform (`mmw-platform`) so the
 * team's client dashboard, onboarding launchpad and Site Intelligence context
 * exist before the AE's kickoff call.
 *
 *   whizhq.create_client   -> POST /api/automation/clients/onboard
 *   whizhq.site_bootstrap  -> POST /api/automation/site-intelligence/bootstrap
 *   whizhq.crawl_report    -> GET  ...  /bootstrap?clientId=  (polled, then Slack)
 *
 * Three rules from the integration spec shape all of this:
 *
 * 1. **Fail soft, never block onboarding.** WhizHQ being down, un-deployed or
 *    unconfigured must not stop the engine's own flow. None of these steps is in
 *    phase0.gate's dependency list, and the Wave 1 roll-up depends on them only
 *    softly, so a WhizHQ problem can never hold up the rest of Wave 1.
 * 2. **`clients/onboard` is not idempotent.** WhizHQ client names are not
 *    unique and the endpoint is deliberately dumb, so a second call makes a
 *    second client. Dedupe is ours: the client id is written onto
 *    client_profile_json (which a re-run does NOT clear, unlike output_json) and
 *    checked before every call, and an ambiguous failure is never retried.
 * 3. **The crawl target is the client's OWN site**, resolved the same way
 *    crawl.detect_platform resolves it - never run.domain, which is the domain
 *    the engine just bought for them and has nothing served on it.
 */

// Engine bookkeeping stored on client_profile_json (see INTERNAL_PROFILE_KEYS in
// slack.ts - these are ours, not client answers, so they stay out of the posted
// profile). client_profile_json is the right home rather than the step's
// output_json because rerunRun() clears output_json, and losing the client id is
// how you end up with two WhizHQ clients for one practice.
const CLIENT_ID_KEY = 'whizhq_client_id';
const PORTAL_URL_KEY = 'whizhq_portal_url';
const CRAWL_ID_KEY = 'whizhq_crawl_id';
/** The poll number at which crawl_report restarted a dead crawl (0 = never). */
const RESTART_KEY = 'whizhq_crawl_restarted_at_poll';

export interface WhizhqLink {
  clientId: string | null;
  portalUrl: string | null;
  crawlId: string | null;
  /**
   * The poll number at which a dead crawl was restarted, or 0 if it never was.
   * A count rather than a flag so the polls after a restart get the same
   * "give it a moment to register a live job" grace the first crawl got.
   */
  restartedAtPoll: number;
}

/** What we already know about this run's WhizHQ client. */
export function whizhqLinkOf(run: { client_profile_json?: Record<string, unknown> | null }): WhizhqLink {
  const p = (run.client_profile_json ?? {}) as Record<string, unknown>;
  const str = (k: string) => {
    const v = p[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const restartedAt = p[RESTART_KEY];
  return {
    clientId: str(CLIENT_ID_KEY),
    portalUrl: str(PORTAL_URL_KEY),
    crawlId: str(CRAWL_ID_KEY),
    restartedAtPoll: typeof restartedAt === 'number' && restartedAt > 0 ? restartedAt : 0,
  };
}

/** Merge WhizHQ bookkeeping into client_profile_json without clobbering siblings. */
async function saveLink(runId: string, patch: Record<string, unknown>): Promise<void> {
  const { data } = await db().from('onboarding_runs').select('client_profile_json').eq('id', runId).maybeSingle();
  const existing = (data?.client_profile_json ?? {}) as Record<string, unknown>;
  const { error } = await db().from('onboarding_runs')
    .update({ client_profile_json: { ...existing, ...patch }, updated_at: new Date().toISOString() })
    .eq('id', runId);
  if (error) throw new Error(`whizhq: could not store ${Object.keys(patch).join('/')} on the run: ${error.message}`);
}

/** Every WhizHQ step is inert until both env vars are set, and reports `skipped`. */
const applicableWhenConfigured = () => whizhqConfigured();

// --- whizhq.create_client --------------------------------------------------

/** The payload for call 1, built from the intake profile. */
async function onboardBody(ctx: StepContext): Promise<WhizOnboardRequest> {
  const p = profileOf(ctx.run);
  const name = ((ctx.run.client_name as string | undefined) ?? p.office_name ?? '').trim();
  if (!name) {
    throw new Error(
      'whizhq.create_client: the run has no client name, and WhizHQ needs one to create a client. ' +
      'Set the client name on the run (dashboard) and retry this step.',
    );
  }

  const body: WhizOnboardRequest = { name, client_type: clientTypeFor(ctx.run.recipe as string | null) };

  // The client's existing website, not the domain we bought them. WhizHQ builds
  // its default crawl target from this, so a wrong value crawls the wrong site.
  const host = await clientSiteHost(ctx);
  if (host) body.domain = host;

  if (p.client_specialty) body.vertical = p.client_specialty;

  // Passing a program starts the onboarding launchpad AND switches the client
  // dashboard's onboarding section on (the one section that ships off).
  const program = config.whizhq.program();
  if (program) body.program = program;

  // Slack channel ID (C...), never "#name" - a name is stored as-is and every
  // later WhizHQ post to the channel fails silently.
  const channel = (ctx.run.slack_channel_id as string | undefined)?.trim();
  if (channel) body.slack_channel = channel;

  const ae = config.whizhq.aeEmail();
  if (ae) body.ae_email = ae;

  return body;
}

async function createClientReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const known = whizhqLinkOf(ctx.run);
  if (known.clientId) {
    // Rule 2: never call twice for one run. A re-run reaches this branch.
    await ctx.logEvent({
      level: 'info',
      endpoint: 'whizhq.create_client',
      response_body: { reused: true, client_id: known.clientId },
    });
    return { created: false, reused: true, client_id: known.clientId, portal_url: known.portalUrl };
  }

  const body = await onboardBody(ctx);
  let res: WhizOnboardResponse;
  try {
    res = await whizCall<WhizOnboardResponse>(ctx, '/api/automation/clients/onboard', 'whizhq.clients.onboard', {
      method: 'POST',
      json: body,
    });
  } catch (err) {
    throw describeOnboardFailure(err, ctx);
  }

  const clientId = res.clientId;
  const portalUrl = res.portalUrl ?? null;
  if (!clientId) {
    throw new Error(
      'whizhq.create_client: WhizHQ returned 200 with no clientId. A client may exist - check WhizHQ before retrying.',
    );
  }

  // Persist before anything else can fail: an id we hold is an id we will not
  // duplicate. If this write fails the step flags, and the id is still readable
  // from the response body in this run's technical log.
  await saveLink(ctx.run.id, { [CLIENT_ID_KEY]: clientId, ...(portalUrl ? { [PORTAL_URL_KEY]: portalUrl } : {}) });

  if (!portalUrl) {
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'whizhq.clients.onboard',
      parsed_error: 'no portalUrl in the response - the roll-up will post without a client dashboard link',
    });
  }
  if (body.slack_channel && res.slackMapped === false) {
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'whizhq.clients.onboard',
      parsed_error: `WhizHQ did not map Slack channel ${body.slack_channel}; its later posts for this client have nowhere to go`,
    });
  }
  if (body.ae_email && res.aeAssigned === false) {
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'whizhq.clients.onboard',
      parsed_error: `WhizHQ did not assign AE ${body.ae_email}; the roadmap's AE kickoff button stays pending`,
    });
  }

  return {
    created: true,
    client_id: clientId,
    portal_url: portalUrl,
    onboarding_url: res.onboardingUrl ?? null,
    onboarding_steps: res.onboarding?.total ?? null,
    slack_mapped: res.slackMapped ?? null,
    ae_assigned: res.aeAssigned ?? null,
  };
}

/**
 * Turn a failed create into an error a human can act on. The distinction that
 * matters is whether a client might already exist: on an ambiguous failure the
 * step must NOT be blind-retried, because a duplicate client in WhizHQ splits
 * one practice's work across two records.
 */
function describeOnboardFailure(err: unknown, ctx: StepContext): Error {
  const f = classifyWhizError(err);
  const client = (ctx.run.client_name as string | undefined) ?? 'this client';

  if (WHIZ_AMBIGUOUS.has(f.kind)) {
    return new Error(
      `whizhq.create_client: ${f.message} (HTTP ${f.status || 'no response'}). ` +
      `The client MAY have been created before this failed - check WhizHQ for "${client}" first. ` +
      'If it is there, no action is needed beyond noting the id; if it is not, retry this step.',
    );
  }
  if (f.kind === 'auth') {
    return new Error(`whizhq.create_client: ${f.message}. WHIZHQ_AUTOMATION_KEY does not match WhizHQ's AUTOMATION_KEY. Nothing was created.`);
  }
  if (f.kind === 'bad_request') {
    const aeHint = /ae|email|user/i.test(f.message)
      ? ' WHIZHQ_AE_EMAIL must be an ACTIVE WhizHQ user - fix it or clear it (the client is then created unassigned).'
      : '';
    return new Error(`whizhq.create_client: WhizHQ rejected the payload: ${f.message}. Nothing was created.${aeHint}`);
  }
  // clients/onboard is the one automation route that is already live in WhizHQ,
  // so a 404 here is almost always WHIZHQ_BASE_URL pointing at the wrong host -
  // typically www vs. apex, where the redirect turns this POST into a GET that
  // matches no route. Say that, rather than "not deployed yet".
  if (f.kind === 'not_deployed' && f.status === 404) {
    return new Error(
      'whizhq.create_client: WhizHQ returned 404 for /api/automation/clients/onboard. That route is live, ' +
      'so check WHIZHQ_BASE_URL: it must be the host that answers directly, with no redirect (www vs. apex), ' +
      "and match WhizHQ's own APP_BASE_URL. Nothing was created.",
    );
  }
  return new Error(`whizhq.create_client: ${f.message} (HTTP ${f.status}). Nothing was created.`);
}

async function createClientDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const body = await onboardBody(ctx);
  const known = whizhqLinkOf(ctx.run);

  // There is no read-safe probe for creating a client, but if this run already
  // has one we can at least prove the key works by reading its portal link.
  let probe = 'skipped (no client to read yet)';
  if (known.clientId) {
    try {
      const res = await whizCall<{ portalUrl?: string }>(
        ctx,
        `/api/automation/clients/portal?clientId=${encodeURIComponent(known.clientId)}`,
        'whizhq.clients.portal',
      );
      probe = res.portalUrl ? 'ok' : 'ok (no portalUrl)';
    } catch (err) {
      probe = `failed: ${classifyWhizError(err).message}`;
    }
  }
  return simulated({
    created: false,
    reused: !!known.clientId,
    client_id: known.clientId ?? simId('whiz'),
    portal_url: known.portalUrl,
    probe,
    would_send: body,
  });
}

// --- whizhq.site_bootstrap -------------------------------------------------

/**
 * The URL to crawl. Prefers the URL crawl.detect_platform already PROVED answers
 * (it ladders https/http x apex/www), which is exactly the spec's gotcha: WhizHQ
 * builds its own target as `https://<domain>`, so a site that only answers on
 * http or on a www host needs an explicit targetUrl. Falls back to the profile
 * website, then to letting WhizHQ derive it from the domain we sent in call 1.
 */
async function crawlTargetUrl(ctx: StepContext): Promise<string | null> {
  const detected = await siblingOutput(ctx.run.id, 'crawl.detect_platform');
  const out = detected?.output ?? {};
  if (out.reachable === true && typeof out.final_url === 'string' && /^https?:\/\//i.test(out.final_url)) {
    return out.final_url;
  }
  const host = await clientSiteHost(ctx);
  return host ? `https://${host}` : null;
}

/**
 * Start a crawl + autofill for this run's WhizHQ client.
 *
 * `resetRestart` is owned by the step, not by the restart: whizhq.crawl_report
 * re-calls this to revive a crawl whose process died, and it must NOT clear the
 * "already used my one restart" flag it just set, or a permanently dead crawl
 * would be restarted on every poll.
 */
async function startBootstrap(
  ctx: StepContext,
  { resetRestart }: { resetRestart: boolean },
): Promise<Record<string, unknown>> {
  const known = whizhqLinkOf(ctx.run);
  if (!known.clientId) {
    // create_client skipped or fail-softed. Nothing to bootstrap; say so plainly
    // rather than failing a step whose prerequisite never happened.
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'whizhq.site_bootstrap',
      parsed_error: 'no WhizHQ client on this run - skipping the crawl + autofill',
    });
    return { started: false, skipped: true, reason: 'no_whizhq_client' };
  }

  const targetUrl = await crawlTargetUrl(ctx);
  const body: Record<string, unknown> = {
    clientId: known.clientId,
    maxPages: config.whizhq.crawlMaxPages(),
  };
  if (targetUrl) body.targetUrl = targetUrl;

  try {
    // 409 is a success for us: a crawl is already running (started here or by an
    // AE on the Crawl tab), nothing was started, and its id is in the body - so
    // we adopt it and let the poll step follow it.
    const res = await whizCall<WhizBootstrapResponse & { crawlId?: string; startedAt?: string }>(
      ctx,
      '/api/automation/site-intelligence/bootstrap',
      'whizhq.si.bootstrap',
      { method: 'POST', json: body, okStatuses: [409] },
    );
    const crawlId = res.crawlId ?? null;
    // A 409 comes back through the ok path (okStatuses), and its body carries an
    // `error` string where a 202 carries `ok: true`.
    const adopted = typeof (res as { error?: unknown }).error === 'string';
    if (adopted) {
      await ctx.logEvent({
        level: 'warn',
        endpoint: 'whizhq.si.bootstrap',
        parsed_error: `a crawl was already running for this client (${crawlId ?? 'no id'}); following it instead of starting another`,
      });
    }
    const patch: Record<string, unknown> = {};
    if (crawlId) patch[CRAWL_ID_KEY] = crawlId;
    if (resetRestart) patch[RESTART_KEY] = 0;
    if (Object.keys(patch).length > 0) await saveLink(ctx.run.id, patch);
    return {
      started: true,
      adopted_running_crawl: adopted,
      crawl_id: crawlId,
      target_url: res.targetUrl ?? targetUrl,
      max_pages: body.maxPages,
    };
  } catch (err) {
    const f = classifyWhizError(err);

    // Built but awaiting a deploy + migration 045: log and skip, never fatal.
    if (WHIZ_SKIPPABLE.has(f.kind)) {
      await ctx.logEvent({
        level: 'warn',
        endpoint: 'whizhq.si.bootstrap',
        parsed_error: `${f.message} - WhizHQ's site-intelligence automation route is not live yet (needs AUTOMATION_KEY + migration 045 + a deploy). Skipping the crawl.`,
      });
      return { started: false, skipped: true, reason: 'whizhq_not_deployed' };
    }
    // No crawl target at all: the client has no domain in WhizHQ and we had none
    // to send. Nothing to crawl, and nothing a retry fixes.
    if (f.kind === 'bad_request') {
      await ctx.logEvent({
        level: 'warn',
        endpoint: 'whizhq.si.bootstrap',
        parsed_error: `${f.message} - no crawl target for this client (no website on the intake form). Skipping.`,
      });
      return { started: false, skipped: true, reason: 'no_crawl_target' };
    }
    throw new Error(`whizhq.site_bootstrap: ${f.message} (HTTP ${f.status})`);
  }
}

async function siteBootstrapReal(ctx: StepContext): Promise<Record<string, unknown>> {
  return startBootstrap(ctx, { resetRestart: true });
}

async function siteBootstrapDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const known = whizhqLinkOf(ctx.run);
  const targetUrl = await crawlTargetUrl(ctx);
  return simulated({
    started: false,
    client_id: known.clientId,
    target_url: targetUrl,
    max_pages: config.whizhq.crawlMaxPages(),
    note: 'would start the WhizHQ crawl + client-info/brand-voice autofill',
  });
}

// --- whizhq.crawl_report ---------------------------------------------------

/** Total polls before giving up. Combined with the `poll` profile's flat 60s
 *  gap this is the spec's ~30 minute ceiling. */
const POLL_ATTEMPTS = 32;

/**
 * Post the crawl outcome as a threaded reply under the Wave 1 roll-up, so the
 * roll-up itself never waits on a crawl (the sequencing the spec recommends).
 * Falls back to a top-level channel message if there is no roll-up to thread
 * under - better a loose message than a silently dropped result.
 */
async function postReport(ctx: StepContext, lines: string[]): Promise<Record<string, unknown>> {
  const channel = (ctx.run.slack_channel_id as string | undefined)?.trim();
  if (!channel) {
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'whizhq.crawl_report',
      parsed_error: `no Slack channel on this run; crawl outcome not posted: ${lines.join(' ')}`,
    });
    return { posted: false, reason: 'no_slack_channel' };
  }
  const rollup = await siblingOutput(ctx.run.id, 'slack.wave1_rollup');
  const threadTs = typeof rollup?.output?.ts === 'string' ? rollup.output.ts : undefined;
  const text = lines.join('\n');
  const res = await slackPost<any>(ctx, 'chat.postMessage', {
    channel,
    text,
    mrkdwn: true,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  return { posted: true, ts: res.ts, threaded: !!threadTs };
}

async function crawlReportReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const known = whizhqLinkOf(ctx.run);
  const bootstrap = await siblingOutput(ctx.run.id, 'whizhq.site_bootstrap');
  if (!known.clientId || bootstrap?.output?.started !== true) {
    return { reported: false, skipped: true, reason: 'no_crawl_started' };
  }

  const path = `/api/automation/site-intelligence/bootstrap?clientId=${encodeURIComponent(known.clientId)}`;
  let poll: WhizPoll;
  try {
    poll = await whizCall<WhizPoll>(ctx, path, 'whizhq.si.bootstrap.status');
  } catch (err) {
    const f = classifyWhizError(err);
    // 404 here means this client was never bootstrapped - there is nothing to
    // wait for, so don't burn 30 minutes of polls discovering that.
    if (f.kind === 'not_found' || WHIZ_SKIPPABLE.has(f.kind)) {
      await ctx.logEvent({ level: 'warn', endpoint: 'whizhq.crawl_report', parsed_error: `${f.message} - nothing to report` });
      return { reported: false, skipped: true, reason: f.kind };
    }
    throw new Error(`whizhq.crawl_report: ${f.message} (HTTP ${f.status})`);
  }

  const host = (poll.crawl?.targetUrl ?? (await clientSiteHost(ctx))) ?? 'the client site';

  // A crawl saying `running` with no live job behind it died with the process
  // that was running it (WhizHQ keeps crawl job state in memory). Restart it
  // once, then give up - the spec's "retry bootstrap once, then give up".
  // Counted from the restart, if there was one: the replacement crawl deserves
  // the same grace as the first, or the poll right after a restart would read
  // "not live yet" as "died again" and give up on a healthy crawl.
  const pollsOnThisCrawl = ctx.attempt - known.restartedAtPoll;
  if (isDeadCrawl(poll, pollsOnThisCrawl)) {
    if (known.restartedAtPoll === 0) {
      await ctx.logEvent({
        level: 'warn',
        endpoint: 'whizhq.crawl_report',
        parsed_error: 'WhizHQ crawl is marked running with no live job (its process died mid-crawl) - restarting it once',
      });
      // Mark the restart as spent BEFORE attempting it: if the restart itself
      // fails we must not try again on the next poll.
      await saveLink(ctx.run.id, { [RESTART_KEY]: ctx.attempt });
      await startBootstrap(ctx, { resetRestart: false });
      throw new Error('waiting on WhizHQ: restarted a dead crawl, now polling the new one');
    }
    const lines = [
      `⚠️ WhizHQ's crawl of ${host} died mid-run and restarting it did not recover it.`,
      'Client info and brand voice were not filled in. Re-run the crawl from the Site Intelligence tab once the platform is stable.',
    ];
    await postReport(ctx, lines);
    throw new Error('whizhq.crawl_report: the WhizHQ crawl died and the one allowed restart did not recover it - needs a human');
  }

  if (!bootstrapFinished(poll)) {
    if (ctx.attempt >= POLL_ATTEMPTS) {
      const lines = [
        `⚠️ WhizHQ's crawl of ${host} has not finished after ~30 minutes.`,
        `Last seen: ${pollProgressLine(poll, ctx.attempt, POLL_ATTEMPTS)}.`,
        'Client info and brand voice may still be empty - check the Site Intelligence tab.',
      ];
      await postReport(ctx, lines);
      throw new Error(`whizhq.crawl_report: gave up after ${POLL_ATTEMPTS} polls (~30 min); the crawl is still running`);
    }
    // Not an error, a wait: the `poll` retry profile re-claims this step in 60s.
    throw new Error(pollProgressLine(poll, ctx.attempt, POLL_ATTEMPTS));
  }

  const summary = summarizeBootstrap(poll, host);
  if (crawlFailed(poll)) {
    // A blocked host reads zero pages and the crawl FAILS rather than finalizing.
    // Report it as the failure it is - never as a completed crawl.
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'whizhq.crawl_report',
      parsed_error: `WhizHQ crawl ${poll.crawl?.status}: ${poll.crawl?.error ?? 'no pages read'}`,
    });
  }
  const posted = await postReport(ctx, [summary.headline, ...summary.detail]);
  return { reported: true, polls: ctx.attempt, ...summary.facts, ...posted };
}

async function crawlReportDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const known = whizhqLinkOf(ctx.run);
  return simulated({
    reported: false,
    client_id: known.clientId,
    crawl_id: known.crawlId,
    note: 'would poll the WhizHQ crawl once a minute and reply in the roll-up thread with what it filled in',
  });
}

// --- registration ----------------------------------------------------------

export const whizhqSteps: Step[] = [
  {
    // Hand the client off to WhizHQ. Waits on the Slack channel (SOFT) so the
    // channel id can be mapped in the same call - a Slack problem must not stop
    // the client being created, it just means WhizHQ's later posts have no home
    // until someone maps it by hand.
    key: 'whizhq.create_client',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: ['profile.normalize_intake'],
    softDependsOn: ['slack.create_channel'],
    // Deliberately 1. Every failure mode here is either pointless to retry
    // (401/400/404) or ambiguous about whether a client was created (5xx,
    // timeout) - and WhizHQ has no uniqueness constraint to save us from a
    // duplicate. A human checks WhizHQ, then clicks retry on this step.
    maxAttempts: 1,
    isApplicable: applicableWhenConfigured,
    runReal: createClientReal,
    runDry: createClientDry,
  },
  {
    // Crawl the client's site and autofill their client info + brand voice, so
    // the profile is populated before the AE's kickoff call. Fire and forget:
    // whizhq.crawl_report follows the outcome.
    key: 'whizhq.site_bootstrap',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: ['whizhq.create_client'],
    // Ordering only: detect_platform has already found which URL of the client's
    // site actually answers, and passing that beats letting WhizHQ guess
    // https://<domain> for a www-only or http-only host.
    softDependsOn: ['crawl.detect_platform'],
    maxAttempts: 2,
    isApplicable: applicableWhenConfigured,
    runReal: siteBootstrapReal,
    runDry: siteBootstrapDry,
  },
  {
    // Wait for the crawl + both autofill passes, then reply in the roll-up
    // thread with what WhizHQ actually filled in. SOFT on the roll-up so it has
    // a message to thread under, but it still posts if the roll-up never did.
    key: 'whizhq.crawl_report',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: ['whizhq.site_bootstrap'],
    softDependsOn: ['slack.wave1_rollup'],
    maxAttempts: POLL_ATTEMPTS,
    retryProfile: 'poll',
    isApplicable: applicableWhenConfigured,
    runReal: crawlReportReal,
    runDry: crawlReportDry,
  },
];
