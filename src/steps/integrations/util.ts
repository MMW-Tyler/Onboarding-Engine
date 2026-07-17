import type { OnboardingRun } from '../../types.js';
import { db } from '../../supabase.js';

/** Read another step's output_json + status on the same run (for synthesis steps). */
export async function siblingOutput(
  runId: string,
  stepKey: string,
): Promise<{ status: string; output: Record<string, unknown> | null } | null> {
  const { data } = await db()
    .from('run_steps')
    .select('status, output_json')
    .eq('run_id', runId)
    .eq('step_key', stepKey)
    .maybeSingle();
  if (!data) return null;
  return { status: data.status as string, output: (data.output_json as Record<string, unknown>) ?? null };
}

/** Non-sensitive client profile for a run. */
export function profileOf(run: OnboardingRun): Record<string, string> {
  const p = (run.client_profile_json ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === '_restricted') continue;
    if (v == null) continue;
    // client_profile_json also holds a few array/object values written by other
    // steps (e.g. mailgun's DNS record arrays) - String() on those collapses to
    // "[object Object]" instead of anything useful, so stringify structured
    // values as JSON and leave everything else as plain String() coercion.
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
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
