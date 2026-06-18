import type { OnboardingRun } from '../../types.js';

/** Non-sensitive client profile for a run. */
export function profileOf(run: OnboardingRun): Record<string, string> {
  const p = (run.client_profile_json ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === '_restricted') continue;
    if (v != null) out[k] = String(v);
  }
  return out;
}

/** Restricted (sensitive) values for a run - use only for real external writes, never log. */
export function restrictedOf(run: OnboardingRun): Record<string, string> {
  const p = (run.client_profile_json ?? {}) as Record<string, unknown>;
  return ((p as Record<string, unknown>)._restricted ?? {}) as Record<string, string>;
}

/** A stable-ish fake id for dry-run simulated outputs. */
export function simId(prefix: string): string {
  return `${prefix}_DRY_${Math.random().toString(36).slice(2, 10)}`;
}

/** Marker added to every simulated (dry-run) output. */
export function simulated(extra: Record<string, unknown>): Record<string, unknown> {
  return { simulated: true, ...extra };
}

/** Slugify a client name into a Slack-safe channel name. */
export function slugifyChannel(name: string, prefix = 'client-'): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return (prefix + (slug || 'unnamed')).slice(0, 80);
}
