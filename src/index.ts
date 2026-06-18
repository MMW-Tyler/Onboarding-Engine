import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config, getRunMode } from './config.js';
import { startLoop } from './engine/loop.js';
import { runsRouter } from './routes/runs.js';
import { webhooksRouter } from './routes/webhooks.js';
import { dashboardRouter } from './routes/dashboard.js';

// public/ lives at the repo root, one level above the compiled dist/ dir.
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

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

// The dashboard UI (spec section 10) is served at the root.
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

app.listen(config.port, () => {
  console.log(`[web] OnboardEngine listening on :${config.port} (mode=${getRunMode()})`);
  startLoop();
});
