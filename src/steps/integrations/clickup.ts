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
const CU3 = 'https://api.clickup.com/api/v3';

function authHeader(): Record<string, string> {
  return { authorization: config.clickup.apiToken() };
}

function clientName(ctx: StepContext): string {
  return (ctx.run.client_name as string) || (profileOf(ctx.run).office_name ?? ctx.run.id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface DocPage {
  id: string;
  name?: string;
  pages?: DocPage[];
}

/** Depth-first search a (possibly nested) ClickUp doc page tree. */
function findPage(pages: DocPage[], pred: (p: DocPage) => boolean): DocPage | null {
  for (const p of pages) {
    if (pred(p)) return p;
    const child = findPage(p.pages ?? [], pred);
    if (child) return child;
  }
  return null;
}

/**
 * Best-effort rename of the master-record doc that rides along with the cloned
 * folder. The folder-template duplicate copies the doc, but its root page keeps
 * the template title ("{Client Name} Master Record"); we rename that page to the
 * real client name so the open doc reads correctly.
 *
 * NOTE: ClickUp's public API has no endpoint to rename a Doc's top-level name,
 * so the folder's doc-list label keeps its "{{Client Name}} Master Record
 * (copy)" artifact - that one stays a manual tidy-up. We rename the page (the
 * in-doc title + what search indexes), which is the most the API allows.
 * Requires CLICKUP_TEAM_ID (the v3 Docs API is workspace-scoped).
 */
async function renameMasterDoc(ctx: StepContext, folderId: string, name: string): Promise<Record<string, unknown>> {
  const workspaceId = config.clickup.teamId();
  if (!workspaceId) {
    await ctx.logEvent({ level: 'warn', endpoint: 'clickup.doc.rename', response_body: { skipped: 'CLICKUP_TEAM_ID not set' } });
    return { renamed: false, reason: 'no_team_id' };
  }

  // Find the doc inside the freshly cloned folder (parent_type 5 = Folder). The
  // folder-template duplicate populates its doc asynchronously, so poll a few
  // times before giving up rather than racing the clone.
  const searchUrl = `${CU3}/workspaces/${workspaceId}/docs?parent_id=${folderId}&parent_type=5&limit=50`;
  let doc: any | undefined;
  let lastCount = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) await sleep(3000);
    const search = await callApi<any>(ctx, searchUrl, 'clickup.doc.search', { headers: authHeader() });
    const docs: any[] = search.body?.docs ?? (Array.isArray(search.body) ? search.body : []);
    lastCount = docs.length;
    const inFolder = docs.filter((d) => !d?.parent?.id || String(d.parent.id) === String(folderId));
    doc = inFolder.find((d) => /master record/i.test(d?.name ?? '')) ?? inFolder[0];
    if (doc?.id) break;
  }
  if (!doc?.id) {
    await ctx.logEvent({ level: 'warn', endpoint: 'clickup.doc.rename', response_body: { reason: 'doc_not_found', docs: lastCount } });
    return { renamed: false, reason: 'doc_not_found' };
  }

  // Locate the root "...Master Record" page (still carrying the template title).
  const pagesRes = await callApi<any>(ctx, `${CU3}/workspaces/${workspaceId}/docs/${doc.id}/pages`, 'clickup.doc.pages', { headers: authHeader() });
  const pages: DocPage[] = Array.isArray(pagesRes.body) ? pagesRes.body : (pagesRes.body?.pages ?? []);
  const page = findPage(pages, (p) => /master record/i.test(p.name ?? '')) ?? pages[0];
  if (!page?.id) {
    return { renamed: false, reason: 'page_not_found', doc_id: doc.id };
  }

  const newName = `${name} Master Record`;
  await callApi(ctx, `${CU3}/workspaces/${workspaceId}/docs/${doc.id}/pages/${page.id}`, 'clickup.doc.page.rename', {
    method: 'PUT', headers: authHeader(), json: { name: newName },
  });
  return { renamed: true, doc_id: doc.id, page_id: page.id, page_name: newName, doc_label_unchanged: doc.name ?? null };
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
  let masterDoc: Record<string, unknown> = { renamed: false, reason: 'no_folder' };
  if (folderId) {
    await db().from('onboarding_runs').update({ clickup_folder_id: folderId, updated_at: new Date().toISOString() }).eq('id', ctx.run.id);
    // Best-effort: rename the cloned master-record doc's page. A failure here
    // must not fail the clone (the folder + tracker are what matter).
    try {
      masterDoc = await renameMasterDoc(ctx, folderId, clientName(ctx));
    } catch (err) {
      masterDoc = { renamed: false, error: err instanceof Error ? err.message : String(err) };
      await ctx.logEvent({ level: 'warn', endpoint: 'clickup.doc.rename', response_body: masterDoc });
    }
  }
  return { folder_id: folderId ?? null, name: clientName(ctx), master_doc: masterDoc };
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
