import type { Step, StepContext } from '../../types.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { profileOf } from './util.js';

/**
 * DataForSEO worker (spec section 08: dataforseo.pull). Wave 2, read-safe:
 * the same function runs for both runReal and runDry because this is a paid
 * read API that is classed read-safe per spec - it has no irreversible side
 * effects. Keyword ideas are used downstream by seo.roadmap (Prompt 5).
 *
 * TODO: Confirm the exact endpoint, credit cost, and per-call pricing with the
 * DataForSEO dashboard before enabling heavy production use. The "Labs / Google
 * keyword ideas / live" endpoint used here is synchronous and straightforward,
 * but costs credits on every call. Competitor domain pulls (e.g. the
 * dataforseo_labs/google/competitors_domain/live endpoint) can be added as a
 * second step once credit usage is understood.
 */

const DFS_BASE = 'https://api.dataforseo.com';

/** Build the Basic auth header from the configured login/password. */
function authHeader(): string {
  const token = Buffer.from(
    `${config.dataforseo.login()}:${config.dataforseo.password()}`,
  ).toString('base64');
  return `Basic ${token}`;
}

/**
 * Build up to 5 keyword seed phrases from the client profile.
 * Combines focus_services x geo_targets (e.g. "med spa Dallas").
 * Falls back to whatever is available if only one dimension exists.
 */
function buildSeeds(p: Record<string, string>): string[] {
  const services = (p.focus_services ?? '')
    .split(/[,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);

  const geos = (p.geo_targets ?? '')
    .split(/[,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);

  const seeds: string[] = [];

  if (services.length > 0 && geos.length > 0) {
    // Cartesian product, capped at 5.
    outer: for (const svc of services) {
      for (const geo of geos) {
        seeds.push(`${svc} ${geo}`);
        if (seeds.length >= 5) break outer;
      }
    }
  } else if (services.length > 0) {
    seeds.push(...services.slice(0, 5));
  } else if (geos.length > 0) {
    seeds.push(...geos.slice(0, 5));
  }

  return seeds;
}

interface KeywordItem {
  keyword: string;
  volume: number | null;
  competition: number | null;
  cpc: number | null;
}

/** Parse the DataForSEO Labs keyword ideas response defensively. */
function parseKeywords(body: unknown): KeywordItem[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;
  const tasks = Array.isArray(b.tasks) ? b.tasks : [];
  const task0 = tasks[0] as Record<string, unknown> | undefined;
  if (!task0) return [];
  const result = Array.isArray(task0.result) ? task0.result : [];
  const result0 = result[0] as Record<string, unknown> | undefined;
  if (!result0) return [];
  const items = Array.isArray(result0.items) ? result0.items : [];

  return items.slice(0, 25).map((item: unknown) => {
    const i = (item ?? {}) as Record<string, unknown>;
    const info = (i.keyword_info ?? {}) as Record<string, unknown>;
    return {
      keyword: typeof i.keyword === 'string' ? i.keyword : '',
      volume: typeof info.search_volume === 'number' ? info.search_volume : null,
      competition: typeof info.competition === 'number' ? info.competition : null,
      cpc: typeof info.cpc === 'number' ? info.cpc : null,
    };
  });
}

async function dataforseoRun(ctx: StepContext): Promise<Record<string, unknown>> {
  const p = profileOf(ctx.run);
  const seeds = buildSeeds(p);

  // Guard: no seeds -> skip cleanly rather than fire an empty API call.
  if (seeds.length === 0) {
    return { skipped: true, reason: 'no focus_services/geo_targets to query' };
  }

  // POST to the Labs Google keyword ideas live endpoint (synchronous; results
  // are returned in the same response rather than via a polling task ID).
  const url = `${DFS_BASE}/v3/dataforseo_labs/google/keyword_ideas/live`;
  const taskBody = [
    {
      keywords: seeds,
      location_name: 'United States',
      language_name: 'English',
      limit: 25,
    },
  ];

  const res = await callApi(ctx, url, 'dataforseo.keyword_ideas', {
    method: 'POST',
    headers: {
      authorization: authHeader(),
      'content-type': 'application/json',
    },
    json: taskBody,
  });

  const keywords = parseKeywords(res.body);

  return {
    seeds,
    keyword_count: keywords.length,
    keywords,
  };
}

export const dataforseoSteps: Step[] = [
  {
    key: 'dataforseo.pull',
    wave: 2,
    safetyClass: 'read-safe',
    // Seeds come from focus_services + geo_targets, which are filled properly by
    // the richer Client MMW onboarding form. Gated on profile.normalize_clientform
    // so this paid pull runs once, on real data, after the second form arrives.
    dependsOn: ['phase0.gate', 'profile.normalize_clientform'],
    maxAttempts: 3,
    retryProfile: 'standard',
    isApplicable: () => true,
    // read-safe: run for real in both live and dry modes (no write side-effects).
    runReal: dataforseoRun,
    runDry: dataforseoRun,
  },
];
