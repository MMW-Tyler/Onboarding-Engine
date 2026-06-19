import { Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase.js';
import { getRunMode, setRunMode, config } from '../config.js';
import { recipes } from '../recipes.js';

/**
 * Control/status surface backing the dashboard UI (spec section 10): status,
 * the dry/live toggle, and the recipe list for the manual trigger panel.
 */
export const dashboardRouter = Router();

/** GET /recipes - recipe names + their step keys, for the trigger panel. */
dashboardRouter.get('/recipes', (_req, res) => {
  return res.json(recipes);
});

/**
 * GET /clickup/discover - read-only helper to find the ClickUp IDs you need:
 * lists spaces (for CLICKUP_TEMPLATE_SPACE_ID) and folder templates (for
 * CLICKUP_FOLDER_TEMPLATE_ID). Requires CLICKUP_API_TOKEN + CLICKUP_TEAM_ID.
 */
dashboardRouter.get('/clickup/discover', async (_req, res) => {
  const headers = { authorization: config.clickup.apiToken() };
  const team = config.clickup.teamId();
  const get = async (url: string) => {
    try {
      const r = await fetch(url, { headers });
      const t = await r.text();
      try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
    } catch (err) {
      return { status: 0, body: err instanceof Error ? err.message : String(err) };
    }
  };
  const base = 'https://api.clickup.com/api/v2';
  const [spaces, folderTemplates] = await Promise.all([
    get(`${base}/team/${team}/space`),
    get(`${base}/team/${team}/folder_template?page=0`),
  ]);
  return res.json({
    note: 'spaces -> CLICKUP_TEMPLATE_SPACE_ID (id of the space holding client folders); folder_templates -> CLICKUP_FOLDER_TEMPLATE_ID',
    teamId: team || '(CLICKUP_TEAM_ID not set)',
    spaces,
    folder_templates: folderTemplates,
  });
});

/**
 * GET /drive/check - diagnose Google Drive service-account auth without exposing
 * secrets. Reports whether GDRIVE_SA_JSON parses, the client_email (which must be
 * shared into the Drive parent folder), and the result of a real token exchange.
 */
dashboardRouter.get('/drive/check', async (_req, res) => {
  const out: Record<string, unknown> = {};
  let creds: any;
  try {
    creds = JSON.parse(config.drive.saJson());
    out.json_parsed = true;
    out.client_email = creds.client_email ?? null;
    out.project_id = creds.project_id ?? null;
    out.private_key_present = typeof creds.private_key === 'string';
    out.private_key_looks_pem = typeof creds.private_key === 'string' && creds.private_key.includes('BEGIN PRIVATE KEY');
    out.parent_folder_id = config.drive.parentFolderId();
  } catch (err) {
    return res.json({ json_parsed: false, error: err instanceof Error ? err.message : String(err) });
  }
  try {
    const { getGoogleAccessToken } = await import('../lib/google.js');
    await getGoogleAccessToken(config.drive.saJson());
    out.authorize = 'ok';
  } catch (err) {
    out.authorize = 'failed';
    out.authorize_error = err instanceof Error ? err.message : String(err);
  }
  return res.json(out);
});

/** GET /status - current mode + run/step/job counts. */
dashboardRouter.get('/status', async (_req, res) => {
  const [steps, jobs] = await Promise.all([
    db().from('run_steps').select('status'),
    db().from('jobs').select('status'),
  ]);
  return res.json({
    mode: getRunMode(),
    steps: tally((steps.data ?? []).map((r) => r.status as string)),
    jobs: tally((jobs.data ?? []).map((r) => r.status as string)),
  });
});

/** POST /mode {mode} - the dashboard dry/live toggle (spec section 04). */
const modeSchema = z.object({ mode: z.enum(['dry', 'live']) });
dashboardRouter.post('/mode', (req, res) => {
  const parsed = modeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'mode must be dry|live' });
  setRunMode(parsed.data.mode);
  return res.json({ mode: getRunMode() });
});

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}
