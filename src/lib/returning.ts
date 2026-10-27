import { toHost, looksLikeDomain } from './domain.js';

/**
 * Returning clients (2026-10-27). A practice coming back, or a device client
 * moving up to a full program, already has a Slack channel, a Drive folder and
 * history the team relies on. Running full_onboarding blind made a second
 * channel and a second Drive folder for O Aesthetics & Wellness, splitting the
 * team across three channels.
 *
 * The Sales Intake form now asks whether the client is existing and, if so, for
 * links to their channel and Drive folder. Everything here is pure (no network)
 * so the webhook, the Drive step and the roll-up all read the answers the same
 * way and it can be tested in isolation.
 */

/** "Yes", "yes - returning", "Existing client", "true" -> true. Anything else -> false. */
export function isYesAnswer(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\s*(y|yes|yep|yeah|true|existing|returning)\b/i.test(value);
}

/**
 * A Slack channel id from what a rep pastes: the channel's "Copy link" URL
 * (https://<workspace>.slack.com/archives/C0A74B923P0, optionally with a /p...
 * message suffix), the web-client URL (https://app.slack.com/client/T.../C...),
 * or a bare id. A channel NAME ("#candela--venice-kim") is not an id and yields
 * null: resolving names needs the bot to be in private channels, which is the
 * very thing that is usually missing on an old channel.
 */
export function slackChannelIdFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  const fromUrl =
    v.match(/\/archives\/([CG][A-Z0-9]{8,})/i) ?? v.match(/\/client\/T[A-Z0-9]+\/([CG][A-Z0-9]{8,})/i);
  if (fromUrl) return fromUrl[1]!.toUpperCase();
  // Real ids are uppercase; requiring that keeps a lowercase channel name such
  // as "grandmother-dental" from passing for one.
  return /^[CG][A-Z0-9]{8,}$/.test(v) ? v : null;
}

/**
 * A Drive folder id from a folder URL (https://drive.google.com/drive/folders/<id>,
 * /drive/u/0/folders/<id>, ?usp=... suffixes), an open?id=<id> link, or a bare id.
 */
export function driveFolderIdFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  const fromUrl = v.match(/\/folders\/([A-Za-z0-9_-]{10,})/) ?? v.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (fromUrl) return fromUrl[1]!;
  return /^[A-Za-z0-9_-]{25,}$/.test(v) ? v : null;
}

export interface ReturningAnswers {
  /** The rep answered yes to "existing MMW client?". */
  saidExisting: boolean;
  /** What they typed for the channel, verbatim (so a bad paste can be quoted back). */
  slackAnswer: string | null;
  slackChannelId: string | null;
  driveAnswer: string | null;
  driveFolderId: string | null;
}

/** Read the returning-client answers from a normalized intake profile. */
export function readReturningAnswers(profile: Record<string, unknown>): ReturningAnswers {
  const str = (k: string) => (typeof profile[k] === 'string' && (profile[k] as string).trim() ? (profile[k] as string).trim() : null);
  const slackAnswer = str('existing_slack_channel_link');
  const driveAnswer = str('existing_drive_folder_link');
  return {
    saidExisting: isYesAnswer(str('existing_client')),
    slackAnswer,
    slackChannelId: slackChannelIdFrom(slackAnswer),
    driveAnswer,
    driveFolderId: driveFolderIdFrom(driveAnswer),
  };
}

/** The bits of an onboarding_runs row needed to spot an earlier run for the same practice. */
export interface RunSummary {
  id: string;
  client_name: string | null;
  created_at: string;
  website_url: string | null;
}

/** "O Aesthetics & Wellness" and "O Aesthetics and Wellness" compare equal. */
function nameKey(name: string | null): string {
  return (name ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
}

function siteKey(site: string | null): string {
  return site && looksLikeDomain(site) ? toHost(site) : '';
}

/**
 * The most recent earlier run for the same practice, matched on the client's
 * own website (never run.domain, which is the sending domain we bought) or on
 * the practice name. Only covers clients the engine itself onboarded (it went
 * live in June 2026); older clients are caught only by the form question.
 */
export function findPriorRun(current: RunSummary, others: RunSummary[]): RunSummary | null {
  const site = siteKey(current.website_url);
  const name = nameKey(current.client_name);
  const earlier = others
    .filter((o) => o.id !== current.id && o.created_at < current.created_at)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return earlier.find((o) => (site && siteKey(o.website_url) === site) || (name && nameKey(o.client_name) === name)) ?? null;
}
