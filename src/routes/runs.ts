import { Router } from 'express';
import { z } from 'zod';
import { db } from '../supabase.js';
import { createRun, retryStep, retryAllFlagged, rerunRun, resumeRun, resendRollup } from '../engine/runs.js';
import { buildWave1RollupText } from '../steps/integrations/slack.js';
import { buildWarmupSetup } from '../steps/integrations/warmup.js';
import { redact } from '../redact.js';

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
  // Redact masks sensitive client keys (npi/dea/credentials/...) by name, so the
  // restricted profile bucket and any step output never expose raw values.
  return res.json({
    run: redact(run.data),
    steps: redact(steps.data ?? []),
    events: events.data ?? [],
  });
});

/** DELETE /runs/:id - permanently remove a run and (via FK cascade) its steps,
 *  events, and jobs. Use for clearing test runs from the dashboard. */
runsRouter.delete('/runs/:id', async (req, res) => {
  const { error } = await db().from('onboarding_runs').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, deleted: req.params.id });
});

/** POST /runs/delete-all - bulk delete every run. Guarded by ?confirm=YES so a
 *  stray fetch can't wipe production runs. Use for clearing test data. */
runsRouter.post('/runs/delete-all', async (req, res) => {
  if (req.query.confirm !== 'YES') {
    return res.status(400).json({ error: 'pass ?confirm=YES to confirm bulk delete' });
  }
  // Supabase requires a filter on delete; this matches every row.
  const { error, count } = await db().from('onboarding_runs').delete({ count: 'exact' }).not('id', 'is', null);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, deleted: count ?? 0 });
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

/** POST /runs/:id/rerun {mode?} - re-run the whole run in the given mode
 *  (default live). Resets every step + re-enqueues from scratch, reusing the
 *  same run row. Used to promote a dry run to a real one without re-webhooking. */
const rerunSchema = z.object({ mode: z.enum(['dry', 'live']).optional() });
runsRouter.post('/runs/:id/rerun', async (req, res) => {
  const parsed = rerunSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'mode must be dry|live' });
  try {
    const result = await rerunRun(req.params.id, parsed.data.mode ?? 'live');
    return res.json({ ok: true, ...result });
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

/** POST /runs/:id/resume - retry all flagged + blocked + failed steps, leaving
 *  completed ones alone. Safe recovery that won't duplicate created assets. */
runsRouter.post('/runs/:id/resume', async (req, res) => {
  try {
    const resumed = await resumeRun(req.params.id);
    return res.json({ ok: true, resumed });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /runs/:id/rollup-text - copy-paste-ready plain-text roll-up, for runs
 *  with no Slack channel to auto-post to. */
runsRouter.get('/runs/:id/rollup-text', async (req, res) => {
  try {
    const text = await buildWave1RollupText(req.params.id);
    return res.json({ text });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /runs/:id/warmup-setup - paste-ready SMTP values for attaching the
 *  client's domain to its assigned warmup inbox (creates/resets the Mailgun
 *  SMTP credential; password not persisted). */
runsRouter.get('/runs/:id/warmup-setup', async (req, res) => {
  try {
    return res.json(await buildWarmupSetup(req.params.id));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /runs/:id/post-rollup - re-post the run's roll-up Slack message(s). */
runsRouter.post('/runs/:id/post-rollup', async (req, res) => {
  try {
    const reposted = await resendRollup(req.params.id);
    return res.json({ ok: true, reposted });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
