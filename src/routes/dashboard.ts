import { Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase.js';
import { getRunMode, setRunMode } from '../config.js';
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
