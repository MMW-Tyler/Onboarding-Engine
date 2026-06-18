import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { profileOf, simId, simulated } from './util.js';

/**
 * ClickUp workers (spec section 08 + section 13, one-directional mirror).
 *
 * Two distinct objects in the real MMW workflow:
 *  1. clickup.clone_template - DUPLICATE the client template FOLDER for this
 *     client (POST /space/{spaceId}/folder_template/{templateId}), which clones
 *     all nested lists/tasks. Stores the new folder id on the run.
 *  2. clickup.master_tracker - append a task for this client to the existing
 *     master account tracker LIST (POST /list/{listId}/task), linking the new
 *     folder so the tracker row points at the client's workspace.
 *
 * ClickUp auth uses the raw token with NO "Bearer " prefix.
 */
const CU = 'https://api.clickup.com/api/v2';

function authHeader(): Record<string, string> {
  return { authorization: config.clickup.apiToken() };
}

function clientName(ctx: StepContext): string {
  return (ctx.run.client_name as string) || (profileOf(ctx.run).office_name ?? ctx.run.id);
}

// --- clone_template: duplicate the client template folder ---
async function cloneTemplateReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const spaceId = config.clickup.templateSpaceId();
  const templateId = config.clickup.folderTemplateId();
  const res = await callApi<any>(
    ctx,
    `${CU}/space/${spaceId}/folder_template/${templateId}`,
    'clickup.folder_from_template',
    { method: 'POST', headers: authHeader(), json: { name: clientName(ctx), return_immediately: false } },
  );
  const folderId = (res.body?.folder?.id ?? res.body?.id) as string | undefined;
  if (folderId) {
    await db().from('onboarding_runs').update({ clickup_folder_id: folderId, updated_at: new Date().toISOString() }).eq('id', ctx.run.id);
  }
  return { folder_id: folderId ?? null, name: clientName(ctx) };
}
async function cloneTemplateDry(ctx: StepContext): Promise<Record<string, unknown>> {
  // Read-safe probe: confirm the target space is reachable with this token.
  await callApi(ctx, `${CU}/space/${config.clickup.templateSpaceId()}`, 'clickup.space.get', { headers: authHeader() });
  return simulated({ folder_id: simId('folder'), name: clientName(ctx) });
}

// --- master_tracker: append a task to the master account tracker list ---
function trackerTask(ctx: StepContext): { name: string; description: string } {
  const p = profileOf(ctx.run);
  const folderId = ctx.run.clickup_folder_id as string | undefined;
  const lines = [
    p.office_name ? `Office: ${p.office_name}` : '',
    p.package ? `Package: ${p.package}` : '',
    p.contract_length ? `Contract: ${p.contract_length}` : '',
    p.start_date ? `Start: ${p.start_date}` : '',
    p.client_specialty ? `Specialty: ${p.client_specialty}` : '',
    p.website_url ? `Website: ${p.website_url}` : '',
    p.nap_phone ? `Phone: ${p.nap_phone}` : '',
    folderId ? `Client folder: https://app.clickup.com/${config.clickup.teamId()}/v/f/${folderId}` : '',
    `OnboardEngine run: ${ctx.run.id}`,
  ].filter(Boolean);
  return { name: `Onboarding - ${clientName(ctx)}`, description: lines.join('\n') };
}
async function masterTrackerReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const listId = config.clickup.masterTrackerListId();
  const task = trackerTask(ctx);
  const res = await callApi<any>(ctx, `${CU}/list/${listId}/task`, 'clickup.task.create', {
    method: 'POST', headers: authHeader(), json: task,
  });
  return { task_id: res.body?.id ?? null };
}
async function masterTrackerDry(ctx: StepContext): Promise<Record<string, unknown>> {
  await callApi(ctx, `${CU}/list/${config.clickup.masterTrackerListId()}`, 'clickup.list.get', { headers: authHeader() });
  return simulated({ task_id: simId('task') });
}

export const clickupSteps: Step[] = [
  {
    key: 'clickup.clone_template', wave: 1, safetyClass: 'reversible-write', dependsOn: [], maxAttempts: 3,
    isApplicable: () => true, runReal: cloneTemplateReal, runDry: cloneTemplateDry,
  },
  {
    key: 'clickup.master_tracker', wave: 1, safetyClass: 'reversible-write',
    dependsOn: ['clickup.clone_template', 'profile.normalize_intake'], maxAttempts: 3,
    isApplicable: () => true, runReal: masterTrackerReal, runDry: masterTrackerDry,
  },
];
