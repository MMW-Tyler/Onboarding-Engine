import { Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase.js';
import { createRun, retryStep, retryAllFlagged } from '../engine/runs.js';

export const runsRouter = Router();

const createSchema = z.object({
  recipe: z.string().min(1),
  stepKeys: z.array(z.string()).optional(),
  client: z.object({
    name: z.string().optional(),
    package: z.string().optional(),
    domain: z.string().optional(),
  }).optional(),
  mode: z.enum(['dry', 'live']).optional(),
  input: z.record(z.unknown()).optional(),
});

/** POST /runs {recipe, client, mode, ...} - manual/dashboard trigger (spec section 05). */
runsRouter.post('/runs', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() });
  }
  try {
    const result = await createRun(parsed.data);
    return res.status(201).json(result);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /runs - recent runs. */
runsRouter.get('/runs', async (_req, res) => {
  const { data, error } = await db().from('onboarding_runs')
    .select('id, client_name, recipe, mode, wave1_status, wave2_status, created_at')
    .order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

/** GET /runs/:id - run detail + step grid + recent events. */
runsRouter.get('/runs/:id', async (req, res) => {
  const id = req.params.id;
  const [run, steps, events] = await Promise.all([
    db().from('onboarding_runs').select('*').eq('id', id).maybeSingle(),
    db().from('run_steps').select('*').eq('run_id', id).order('step_key'),
    db().from('step_events').select('*').eq('run_id', id).order('ts', { ascending: false }).limit(100),
  ]);
  if (!run.data) return res.status(404).json({ error: 'run not found' });
  return res.json({ run: run.data, steps: steps.data ?? [], events: events.data ?? [] });
});

/** POST /runs/:id/steps/:key/retry - rerun one step (spec section 10). */
runsRouter.post('/runs/:id/steps/:key/retry', async (req, res) => {
  try {
    await retryStep(req.params.id, req.params.key);
    return res.json({ ok: true, retried: req.params.key });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /runs/:id/retry-flagged - bulk retry all flagged steps (spec section 10). */
runsRouter.post('/runs/:id/retry-flagged', async (req, res) => {
  try {
    const retried = await retryAllFlagged(req.params.id);
    return res.json({ ok: true, retried });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
