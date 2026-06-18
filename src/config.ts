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

  namecheap: {
    baseUrl: optional('NAMECHEAP_BASE_URL', 'https://api.sandbox.namecheap.com'),
    live: process.env.NAMECHEAP_LIVE === 'true',
  },
};

export function getRunMode(): RunMode {
  return runMode;
}

/** Dashboard toggle (spec section 04). Process-local; persists for the life of the service. */
export function setRunMode(mode: RunMode): void {
  runMode = mode;
}
