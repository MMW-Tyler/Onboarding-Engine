import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { simId, simulated } from './util.js';

/**
 * ClickUp workers (spec section 08 + section 13: ClickUp mirror).
 *
 * Two steps:
 *   1. clickup.clone_template  — confirms access to the template list and
 *      records its id on the run as the working list placeholder.
 *   2. clickup.master_tracker  — creates a master tracker task in that list.
 *
 * ClickUp API v2, base https://api.clickup.com/api/v2.
 * Auth: raw token in `authorization` header (no "Bearer " prefix — ClickUp's
 * own API convention).
 *
 * TODO (spec open item — ClickUp template behavior): Real template cloning
 * requires a target space id (POST /space/{spaceId}/list or
 * POST /folder/{folderId}/list). The space id is not currently stored on the
 * run or surfaced in the dashboard, so clone_template falls back to confirming
 * access to the template list and recording its id. Once the target space id
 * is available in config or on the run, replace the GET probe below with a
 * POST that creates a dedicated client folder/list from the template.
 */

const BASE = 'https://api.clickup.com/api/v2';

/** ClickUp uses a raw API token with no "Bearer " prefix. */
function authHeader(): Record<string, string> {
  return { authorization: config.clickup.apiToken() };
}

// ---------------------------------------------------------------------------
// clone_template
// ---------------------------------------------------------------------------

/**
 * Real: read the template list to confirm connectivity and capture its id.
 * Writes clickup_folder_id (used as the working list id placeholder) to the
 * run row so downstream steps can reference it.
 *
 * TODO: When a target space id becomes available, replace this with a call to
 * POST /space/{spaceId}/list (or POST /folder/{folderId}/list) that creates a
 * real per-client list based on the template.
 */
async function cloneTemplateReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const templateListId = config.clickup.templateListId();

  // Confirm we can reach the template list.
  const res = await callApi<any>(
    ctx,
    `${BASE}/list/${templateListId}`,
    'clickup.get_template_list',
    { headers: authHeader() },
  );

  const listId: string = res.body.id ?? templateListId;
  const taskCount: number = res.body.task_count ?? 0;

  // Persist the template list id as the working clickup_folder_id until real
  // per-client list creation is implemented (see TODO above).
  await db()
    .from('onboarding_runs')
    .update({ clickup_folder_id: listId, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  return { template_list_id: listId, task_count: taskCount };
}

/**
 * Dry: probe the template list (read-safe) to verify the token and list id,
 * then return a simulated result without writing the run row.
 */
async function cloneTemplateDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const templateListId = config.clickup.templateListId();

  // Probe only — confirms the API token and list id are valid.
  await callApi<any>(
    ctx,
    `${BASE}/list/${templateListId}`,
    'clickup.get_template_list',
    { headers: authHeader() },
  );

  return simulated({ list_id: simId('list'), task_count: 0 });
}

// ---------------------------------------------------------------------------
// master_tracker
// ---------------------------------------------------------------------------

/** Display name for the client, falling back to the run id if not set. */
function clientName(ctx: StepContext): string {
  return (ctx.run.client_name as string) || ctx.run.id;
}

/**
 * Real: create a master tracker task in the template list (used as the working
 * list until per-client list creation is implemented — see clone_template TODO).
 */
async function masterTrackerReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const templateListId = config.clickup.templateListId();
  const name = clientName(ctx);

  const res = await callApi<any>(
    ctx,
    `${BASE}/list/${templateListId}/task`,
    'clickup.create_tracker_task',
    {
      method: 'POST',
      headers: authHeader(),
      json: {
        name: `Onboarding — ${name}`,
        description: `Master tracker task for client onboarding run ${ctx.run.id}.`,
      },
    },
  );

  const taskId: string = res.body.id;
  return { task_id: taskId };
}

/**
 * Dry: probe the template list to verify connectivity, then return a simulated
 * task id without creating anything in ClickUp.
 */
async function masterTrackerDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const templateListId = config.clickup.templateListId();

  // Read-safe probe — confirms access before we'd attempt the real POST.
  await callApi<any>(
    ctx,
    `${BASE}/list/${templateListId}`,
    'clickup.get_template_list',
    { headers: authHeader() },
  );

  return simulated({ task_id: simId('task') });
}

// ---------------------------------------------------------------------------
// Exported step array
// ---------------------------------------------------------------------------

export const clickupSteps: Step[] = [
  {
    key: 'clickup.clone_template',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: [],
    maxAttempts: 3,
    isApplicable: () => true,
    runReal: cloneTemplateReal,
    runDry: cloneTemplateDry,
  },
  {
    key: 'clickup.master_tracker',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: ['clickup.clone_template'],
    maxAttempts: 3,
    isApplicable: () => true,
    runReal: masterTrackerReal,
    runDry: masterTrackerDry,
  },
];
