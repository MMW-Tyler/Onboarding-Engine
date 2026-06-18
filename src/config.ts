import 'dotenv/config';

/**
 * Central config. Env-driven, with safe defaults. See spec section 15.
 * RUN_MODE is the one global dry/live toggle (spec section 04); the dashboard
 * can flip it at runtime via setRunMode().
 */

export type RunMode = 'dry' | 'live';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

let runMode: RunMode = (process.env.RUN_MODE === 'live' ? 'live' : 'dry');

export const config = {
  port: Number(process.env.PORT ?? 10000),
  webhookSecret: optional('MMW_WEBHOOK_SECRET'),
  loopIntervalMs: Number(process.env.LOOP_INTERVAL_MS ?? 4000),
  jobClaimTimeoutMs: Number(process.env.JOB_CLAIM_TIMEOUT_MS ?? 300000),

  supabaseUrl: () => required('SUPABASE_URL'),
  supabaseServiceKey: () => required('SUPABASE_SERVICE_KEY'),

  anthropicApiKey: () => required('ANTHROPIC_API_KEY'),

  slack: {
    botToken: () => required('SLACK_BOT_TOKEN'),
    fallbackChannelId: () => optional('SLACK_FALLBACK_CHANNEL_ID'),
  },
  hubspot: {
    accessToken: () => required('HUBSPOT_ACCESS_TOKEN'),
  },
  clickup: {
    apiToken: () => required('CLICKUP_API_TOKEN'),
    teamId: () => optional('CLICKUP_TEAM_ID'),
    masterTrackerListId: () => required('CLICKUP_MASTER_TRACKER_LIST_ID'),
    folderTemplateId: () => required('CLICKUP_FOLDER_TEMPLATE_ID'),
    templateSpaceId: () => required('CLICKUP_TEMPLATE_SPACE_ID'),
  },
  drive: {
    saJson: () => required('GDRIVE_SA_JSON'),
    parentFolderId: () => required('CLIENTS_PARENT_FOLDER_ID'),
  },
  namecheap: {
    apiUser: () => required('NAMECHEAP_API_USER'),
    apiKey: () => required('NAMECHEAP_API_KEY'),
    clientIp: () => required('NAMECHEAP_CLIENT_IP'),
    baseUrl: optional('NAMECHEAP_BASE_URL', 'https://api.sandbox.namecheap.com'),
    live: process.env.NAMECHEAP_LIVE === 'true',
  },
  mailgun: {
    apiKey: () => required('MAILGUN_API_KEY'),
    region: () => optional('MAILGUN_REGION', 'us'),
  },
  warmup: {
    apiKey: () => required('WARMUPINBOX_API_KEY'),
  },
  ghl: {
    apiKey: () => required('GHL_API_KEY'),
    agencyLocationId: () => optional('GHL_AGENCY_LOCATION_ID'),
    snapshotId: () => optional('GHL_SNAPSHOT_ID'),
    a2pFieldMap: () => optional('GHL_A2P_CUSTOM_FIELD_MAP'),
  },
  dataforseo: {
    login: () => required('DATAFORSEO_LOGIN'),
    password: () => required('DATAFORSEO_PASSWORD'),
  },
  googlePlaces: {
    apiKey: () => required('GOOGLE_PLACES_API_KEY'),
  },
  adviceLocal: {
    apiKey: () => required('ADVICELOCAL_API_KEY'),
  },
};

export function getRunMode(): RunMode {
  return runMode;
}

/** Dashboard toggle (spec section 04). Process-local; persists for the life of the service. */
export function setRunMode(mode: RunMode): void {
  runMode = mode;
}
