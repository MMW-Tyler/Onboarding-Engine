import express from 'express';
import { config, getRunMode } from './config.js';
import { startLoop } from './engine/loop.js';
import { runsRouter } from './routes/runs.js';
import { webhooksRouter } from './routes/webhooks.js';
import { dashboardRouter } from './routes/dashboard.js';

/**
 * One always-on Render service (spec section 03): it listens for webhooks,
 * serves the dashboard/API, AND runs the checklist loop in the background.
 */
const app = express();
app.use(express.json({ limit: '2mb' }));

// Liveness probe for Render.
app.get('/healthz', (_req, res) => res.json({ ok: true, mode: getRunMode() }));

app.use(webhooksRouter);
app.use(runsRouter);
app.use(dashboardRouter);

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    [
      'MMW OnboardEngine',
      `mode: ${getRunMode()}`,
      '',
      'GET  /healthz',
      'GET  /status',
      'POST /mode               {mode: dry|live}',
      'POST /runs               {recipe, client?, mode?, input?, stepKeys?}',
      'GET  /runs',
      'GET  /runs/:id',
      'POST /runs/:id/steps/:key/retry',
      'POST /runs/:id/retry-flagged',
      'POST /webhook/intake     (Zapier doorbell)',
      'POST /webhook/clientform (Zapier doorbell)',
    ].join('\n'),
  );
});

app.listen(config.port, () => {
  console.log(`[web] OnboardEngine listening on :${config.port} (mode=${getRunMode()})`);
  startLoop();
});
