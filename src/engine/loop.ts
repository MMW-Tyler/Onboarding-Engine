import { db } from '../supabase.js';
import { config } from '../config.js';
import { processJob, type JobRow } from './runner.js';

/**
 * The checklist loop (spec section 07). Runs inside the same always-on process
 * as the web server. Claims one ready job at a time via the claim_next_job()
 * RPC (FOR UPDATE SKIP LOCKED), processes it, and drains the queue before
 * sleeping LOOP_INTERVAL_MS. claim_next_job also reclaims jobs that were claimed
 * but never finished (e.g. a mid-step restart), so nothing is stranded.
 */
let running = false;
let stopRequested = false;

export function startLoop(): void {
  if (running) return;
  running = true;
  stopRequested = false;
  void tickForever();
  console.log(`[loop] checklist loop started (interval=${config.loopIntervalMs}ms)`);
}

export function stopLoop(): void {
  stopRequested = true;
}

async function tickForever(): Promise<void> {
  while (!stopRequested) {
    let didWork = false;
    try {
      didWork = await drain();
    } catch (err) {
      console.error('[loop] tick error:', err instanceof Error ? err.message : err);
    }
    if (!didWork) {
      await sleep(config.loopIntervalMs);
    }
  }
  running = false;
}

/** Claim and process jobs until the queue is empty. Returns true if any ran. */
async function drain(): Promise<boolean> {
  let any = false;
  // Safety bound so a flood of always-ready jobs can't starve the sleep forever.
  for (let i = 0; i < 100; i++) {
    const job = await claimNext();
    if (!job) break;
    any = true;
    await processJob(job);
  }
  return any;
}

async function claimNext(): Promise<JobRow | null> {
  const { data, error } = await db().rpc('claim_next_job', { p_timeout_ms: config.jobClaimTimeoutMs });
  if (error) throw new Error(`claim_next_job: ${error.message}`);
  const rows = (data as JobRow[]) ?? [];
  return rows[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
