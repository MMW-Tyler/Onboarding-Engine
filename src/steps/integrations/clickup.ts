import type { OnboardingRun, Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { packageOf, isPracticePro, type PackageDefinition } from '../../lib/packages.js';
import { profileOf, siblingOutput, simId, simulated } from './util.js';

/**
 * ClickUp workers (spec section 08 + section 13, one-directional mirror).
 *
 * Three distinct objects in the real MMW workflow:
 *  1. clickup.clone_template - DUPLICATE the client template FOLDER for this
 *     client (POST /space/{spaceId}/folder_template/{templateId}), which clones
 *     all nested lists/tasks. Stores the new folder id on the run.
 *  2. clickup.onboarding_list - Practice Pro clients only: duplicate the
 *     "Practice Pro - Onboarding Sample" LIST into the "New Client Onboarding"
 *     folder, named for the client. That is the onboarding checklist the team
 *     works through; the folder from (1) is the client's ongoing workspace.
 *  3. clickup.master_tracker - append a task for this client to the existing
 *     master account tracker LIST (POST /list/{listId}/task), named for the
 *     client and with the tracker's custom fields filled in from the agreement
 *     type + its deliverables (see lib/packages.ts).
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

/**
 * The client's MMW package as free text. profile.normalize_intake puts it on
 * the profile, but fall back to the run column and then to the raw intake
 * payload (same loose label match the intake webhook gates on) so package
 * gating still works if a run is created before/without normalization.
 */
function packageTextOf(run: OnboardingRun): string {
  const p = profileOf(run);
  if (p.package) return p.package;
  if (run.package) return String(run.package);
  const raw = (run.raw_intake_json ?? {}) as Record<string, unknown>;
  for (const [label, value] of Object.entries(raw)) {
    if (!/package|service|program|tier/i.test(label)) continue;
    if (Array.isArray(value)) return value.join(', ');
    if (value != null) return String(value);
  }
  return '';
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

// --- onboarding_list: duplicate the Practice Pro onboarding checklist list ---
//
// ClickUp's public API has no "duplicate list" endpoint (that lives in the UI
// only) and the sample list is not saved as a list template, so the duplicate is
// done by hand: create an empty list in the same folder, then re-create every
// source task in it. The new list inherits the folder's statuses and custom
// fields ("Assigned Role"), so the copies keep both.
//
// Re-runnable: an existing list with the client's name is reused, and tasks
// already present by name are skipped, so a retry after a partial copy resumes
// instead of duplicating.

interface CuOption { id: string; name?: string; label?: string; orderindex?: number }
interface CuField {
  id: string;
  name: string;
  type: string;
  type_config?: { options?: CuOption[] };
}
interface CuTaskField { id: string; name?: string; type?: string; value?: unknown }
interface CuTask {
  id: string;
  name: string;
  orderindex?: string;
  description?: string;
  text_content?: string;
  status?: { status?: string };
  priority?: { priority?: string } | null;
  tags?: { name?: string }[];
  assignees?: { id?: number }[];
  due_date?: string | null;
  start_date?: string | null;
  time_estimate?: number | null;
  parent?: string | null;
  custom_fields?: CuTaskField[];
}

const PRIORITY_IDS: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

function sleepBetweenWrites(): Promise<void> {
  // ClickUp rate-limits at 100 requests/minute per token; the copy is a long
  // burst of writes, so pace it well under the ceiling.
  return sleep(700);
}

/** Status names configured on a list payload (own or inherited from the folder). */
function statusesOf(list: unknown): string[] {
  const raw = (list as { statuses?: { status?: string }[] } | undefined)?.statuses ?? [];
  return raw.map((s) => s.status ?? '').filter(Boolean);
}

/** Custom fields available on a list (own + inherited from folder/space). */
async function listFields(ctx: StepContext, listId: string): Promise<CuField[]> {
  const res = await callApi<any>(ctx, `${CU}/list/${listId}/field`, 'clickup.list.fields', { headers: authHeader() });
  return (res.body?.fields ?? []) as CuField[];
}

/** Every task in a list, including subtasks and closed ones. */
async function listTasks(ctx: StepContext, listId: string): Promise<CuTask[]> {
  const out: CuTask[] = [];
  for (let page = 0; page < 20; page++) {
    const url = `${CU}/list/${listId}/task?subtasks=true&include_closed=true&page=${page}`;
    const res = await callApi<any>(ctx, url, 'clickup.list.tasks', { headers: authHeader() });
    const tasks = (res.body?.tasks ?? []) as CuTask[];
    out.push(...tasks);
    if (res.body?.last_page === true || tasks.length === 0) break;
  }
  return out;
}

/**
 * Carry a source task's custom-field values across. The target list sits in the
 * same folder, so it inherits the same field ids; only fields the target
 * actually has are copied. Dropdown values come back from the API as the
 * option's orderindex but must be written as the option id.
 */
function copyCustomFields(source: CuTask, targetFields: Map<string, CuField>): { id: string; value: unknown }[] {
  const out: { id: string; value: unknown }[] = [];
  for (const f of source.custom_fields ?? []) {
    if (f.value === undefined || f.value === null || f.value === '') continue;
    const target = targetFields.get(f.id);
    if (!target) continue;
    let value = f.value;
    if (target.type === 'drop_down' && typeof value === 'number') {
      const opt = (target.type_config?.options ?? []).find((o) => o.orderindex === value);
      if (!opt) continue;
      value = opt.id;
    }
    out.push({ id: f.id, value });
  }
  return out;
}

function copyTaskBody(source: CuTask, targetFields: Map<string, CuField>, statuses: Set<string>): Record<string, unknown> {
  const body: Record<string, unknown> = { name: source.name };
  const description = source.description ?? source.text_content ?? '';
  if (description) body.description = description;
  // Only send a status the new list actually has - otherwise ClickUp rejects
  // the whole create. Without one the task lands in the list's first status.
  const status = source.status?.status;
  if (status && statuses.has(status.toLowerCase())) body.status = status;
  const priority = source.priority?.priority?.toLowerCase();
  if (priority && PRIORITY_IDS[priority]) body.priority = PRIORITY_IDS[priority];
  const tags = (source.tags ?? []).map((t) => t.name).filter(Boolean);
  if (tags.length > 0) body.tags = tags;
  const assignees = (source.assignees ?? []).map((a) => a.id).filter((id): id is number => typeof id === 'number');
  if (assignees.length > 0) body.assignees = assignees;
  if (source.due_date) body.due_date = Number(source.due_date);
  if (source.start_date) body.start_date = Number(source.start_date);
  if (source.time_estimate) body.time_estimate = source.time_estimate;
  const fields = copyCustomFields(source, targetFields);
  if (fields.length > 0) body.custom_fields = fields;
  return body;
}

async function onboardingListReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const folderId = config.clickup.onboardingFolderId();
  const sourceListId = config.clickup.practiceProListId();
  const name = clientName(ctx);

  // 1. Reuse a same-named list in the folder if one is already there (a retry,
  //    or someone made it by hand), else create it.
  const existing = await callApi<any>(ctx, `${CU}/folder/${folderId}/list?archived=false`, 'clickup.folder.lists', { headers: authHeader() });
  const match = ((existing.body?.lists ?? []) as { id: string; name: string }[])
    .find((l) => (l.name ?? '').trim().toLowerCase() === name.trim().toLowerCase());
  let listId = match?.id;
  const reused = Boolean(listId);
  let statusNames: string[] = [];
  if (listId) {
    statusNames = statusesOf(match);
  } else {
    const created = await callApi<any>(ctx, `${CU}/folder/${folderId}/list`, 'clickup.list.create', {
      method: 'POST', headers: authHeader(), json: { name },
    });
    listId = created.body?.id as string | undefined;
    if (!listId) throw new Error('clickup.onboarding_list: list create returned no id');
    statusNames = statusesOf(created.body);
  }
  const statuses = new Set(statusNames.map((s) => s.toLowerCase()));

  // 2. Copy the sample list's tasks in, skipping any already there by name.
  const [source, already, targetFieldList] = await Promise.all([
    listTasks(ctx, sourceListId),
    reused ? listTasks(ctx, listId) : Promise.resolve([] as CuTask[]),
    listFields(ctx, listId),
  ]);
  const targetFields = new Map(targetFieldList.map((f) => [f.id, f]));
  const nameKey = (t: CuTask) => t.name.trim().toLowerCase();

  // Tasks the target list already has, counted by name so a sample list with
  // two identically named tasks still ends up with two copies.
  const alreadyByName = new Map<string, number>();
  for (const t of already) alreadyByName.set(nameKey(t), (alreadyByName.get(nameKey(t)) ?? 0) + 1);

  // Parents before children, each group in the source list's own order, so the
  // copy reads top-to-bottom the way the sample does and every subtask has a
  // parent to attach to by the time it is created.
  const byOrder = [...source].sort((a, b) => Number(a.orderindex ?? 0) - Number(b.orderindex ?? 0));
  const parents = byOrder.filter((t) => !t.parent);
  const children = byOrder.filter((t) => t.parent);
  const idMap = new Map<string, string>();
  for (const t of already) if (!idMap.has(nameKey(t))) idMap.set(nameKey(t), t.id);

  let created = 0;
  let skipped = 0;
  const orphaned: string[] = [];
  for (const t of [...parents, ...children]) {
    const key = nameKey(t);
    const pending = alreadyByName.get(key) ?? 0;
    if (pending > 0) {
      alreadyByName.set(key, pending - 1);
      skipped += 1;
      continue;
    }
    const body = copyTaskBody(t, targetFields, statuses);
    if (t.parent) {
      // Subtasks are keyed off the copy of their parent; if the parent was not
      // copied (e.g. it lives in another list), keep the task rather than drop it.
      const parentSource = source.find((s) => s.id === t.parent);
      const newParent = parentSource ? idMap.get(nameKey(parentSource)) : undefined;
      if (newParent) body.parent = newParent;
      else orphaned.push(t.name);
    }
    const res = await callApi<any>(ctx, `${CU}/list/${listId}/task`, 'clickup.task.create', {
      method: 'POST', headers: authHeader(), json: body,
    });
    const newId = res.body?.id as string | undefined;
    if (newId && !idMap.has(key)) idMap.set(key, newId);
    created += 1;
    await sleepBetweenWrites();
  }

  if (orphaned.length > 0) {
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'clickup.onboarding_list',
      response_body: { reason: 'subtasks copied without a parent', tasks: orphaned },
    });
  }

  return {
    list_id: listId,
    list_name: name,
    list_url: `https://app.clickup.com/${config.clickup.teamId()}/v/li/${listId}`,
    folder_id: folderId,
    source_list_id: sourceListId,
    reused_existing_list: reused,
    tasks_created: created,
    tasks_skipped: skipped,
    source_task_count: source.length,
  };
}

async function onboardingListDry(ctx: StepContext): Promise<Record<string, unknown>> {
  // Read-safe probe: confirm the folder + sample list are reachable and report
  // how many tasks a live run would copy.
  await callApi(ctx, `${CU}/folder/${config.clickup.onboardingFolderId()}/list`, 'clickup.folder.lists', { headers: authHeader() });
  const source = await listTasks(ctx, config.clickup.practiceProListId());
  return simulated({
    list_id: simId('list'),
    list_name: clientName(ctx),
    folder_id: config.clickup.onboardingFolderId(),
    source_list_id: config.clickup.practiceProListId(),
    tasks_to_copy: source.length,
  });
}

// --- master_tracker: append a task to the master account tracker list ---

/** US state name -> the 2-letter code the tracker's State dropdown uses. */
const STATE_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

export function stateCode(raw: string | undefined): string | undefined {
  const v = (raw ?? '').trim();
  if (!v) return undefined;
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return STATE_CODES[v.toLowerCase()];
}

/** Website CMS dropdown option for a crawl.detect_platform result. */
export function cmsOption(platform: string | undefined): string | undefined {
  const p = (platform ?? '').toLowerCase();
  if (!p || p === 'unknown') return undefined;
  if (p.includes('wordpress')) return 'Wordpress';
  if (p.includes('squarespace')) return 'SquareSpace';
  if (p.includes('wix')) return 'Wix';
  if (p.includes('shopify')) return 'Shopify';
  if (p.includes('webflow')) return 'Webflow';
  if (p.includes('godaddy')) return 'GoDaddy';
  if (p.includes('tebra')) return 'Tebra';
  return 'Other';
}

/** First number in a free-text money answer ("$3,497/mo" -> 3497). */
export function parseMoney(raw: string | undefined): number | undefined {
  const m = (raw ?? '').replace(/,/g, '').match(/\d+(\.\d+)?/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Epoch ms at UTC midnight for a date answer, or undefined if unparseable. */
export function parseDateMs(raw: string | undefined): number | undefined {
  const v = (raw ?? '').trim();
  if (!v) return undefined;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Months in a contract-length answer ("12 months", "1 year"), default 12. */
export function contractMonths(raw: string | undefined): number {
  const v = (raw ?? '').toLowerCase();
  const years = v.match(/(\d+)\s*year/);
  if (years) return Number(years[1]) * 12;
  const months = v.match(/(\d+)\s*month/);
  if (months) return Number(months[1]);
  const bare = v.match(/\d+/);
  return bare ? Number(bare[0]) : 12;
}

function addMonthsMs(ms: number, months: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate());
}

/**
 * Resolve human-readable {field name: value} pairs against the list's live
 * custom-field definitions. Dropdown values are matched to an option by label.
 * Anything that no longer exists in ClickUp is reported rather than written, so
 * a renamed field or option surfaces in the run log instead of failing silently.
 */
export function resolveFields(
  fields: CuField[],
  desired: Record<string, string | number | undefined>,
): { values: { id: string; value: unknown }[]; unresolved: string[] } {
  const byName = new Map(fields.map((f) => [f.name.trim().toLowerCase(), f]));
  const values: { id: string; value: unknown }[] = [];
  const unresolved: string[] = [];

  for (const [name, raw] of Object.entries(desired)) {
    if (raw === undefined || raw === '') continue;
    const field = byName.get(name.trim().toLowerCase());
    if (!field) {
      unresolved.push(`${name} (no such field)`);
      continue;
    }
    if (field.type === 'drop_down') {
      const label = String(raw).trim().toLowerCase();
      const opt = (field.type_config?.options ?? []).find(
        (o) => (o.name ?? o.label ?? '').trim().toLowerCase() === label,
      );
      if (!opt) {
        unresolved.push(`${name} = "${raw}" (no such option)`);
        continue;
      }
      values.push({ id: field.id, value: opt.id });
      continue;
    }
    values.push({ id: field.id, value: raw });
  }
  return { values, unresolved };
}

/**
 * The tracker row's field values: the agreement type and its deliverables from
 * lib/packages.ts, plus the account facts this run already knows. Fields the
 * engine cannot know at Wave 1 (Account Executive, Happiness Level, meeting
 * dates) are deliberately left for a human.
 */
function trackerFieldValues(
  ctx: StepContext,
  pkg: PackageDefinition | null,
  platform: string | undefined,
): { desired: Record<string, string | number | undefined>; notes: string[] } {
  const p = profileOf(ctx.run);
  const desired: Record<string, string | number | undefined> = {
    ...(pkg?.deliverables ?? {}),
    'Contract Type': pkg?.contractType,
    Lifecycle: 'Onboarding',
    City: p.nap_city,
    State: stateCode(p.nap_state),
    'Website CMS': cmsOption(platform),
  };

  // Monthly commitment: what the rep invoiced beats the program's list price.
  const invoiced = parseMoney(p.invoice_amount);
  if (invoiced ?? pkg?.monthlyPrice) desired['Monthly Committment'] = invoiced ?? pkg?.monthlyPrice;

  // The intake form is filled in when the deal closes, so its timestamp is the
  // best "contract signed" date we have; renewal is the start date + term.
  const signed = parseDateMs(p.submitted_at);
  if (signed) desired['Contract Signed'] = signed;
  const start = parseDateMs(p.start_date);
  if (start) desired['Renewal Date'] = addMonthsMs(start, contractMonths(p.contract_length));

  // MMW Built Website only when the intake says we are building/cloning one -
  // a glow-up or a hosting transfer is not an MMW-built site.
  const build = (p.website_build_type ?? p.website_build_notes ?? '').toLowerCase();
  if (/new|build|clone/.test(build)) desired['MMW Built Website'] = 'In Progress';
  else if (/hosting|transfer|existing|glow|none/.test(build)) desired['MMW Built Website'] = 'No';

  const notes = [
    pkg ? `${pkg.contractType} scope: ${pkg.scopeNotes.join('; ')}.` : '',
    p.special_additions ? `Special additions promised: ${p.special_additions}` : '',
    invoiced && pkg && invoiced !== pkg.monthlyPrice
      ? `Invoice amount on intake ($${invoiced}) differs from the ${pkg.contractType} list price ($${pkg.monthlyPrice}) - confirm before billing.`
      : '',
    'Set by OnboardEngine from the Sales Intake form.',
  ].filter(Boolean);
  desired.Notes = notes.join('\n');

  return { desired, notes };
}

function trackerDescription(ctx: StepContext, onboardingListUrl?: string): string {
  const p = profileOf(ctx.run);
  const folderId = ctx.run.clickup_folder_id as string | undefined;
  return [
    p.office_name ? `Office: ${p.office_name}` : '',
    p.package ? `Package: ${p.package}` : '',
    p.contract_length ? `Contract: ${p.contract_length}` : '',
    p.start_date ? `Start: ${p.start_date}` : '',
    p.client_specialty ? `Specialty: ${p.client_specialty}` : '',
    p.website_url ? `Website: ${p.website_url}` : '',
    p.nap_phone ? `Phone: ${p.nap_phone}` : '',
    folderId ? `Client folder: https://app.clickup.com/${config.clickup.teamId()}/v/f/${folderId}` : '',
    onboardingListUrl ? `Onboarding checklist: ${onboardingListUrl}` : '',
    `OnboardEngine run: ${ctx.run.id}`,
  ].filter(Boolean).join('\n');
}

async function masterTrackerReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const listId = config.clickup.masterTrackerListId();
  const pkg = packageOf(packageTextOf(ctx.run));
  const platform = (await siblingOutput(ctx.run.id, 'crawl.detect_platform'))?.output?.platform as string | undefined;
  const listOut = (await siblingOutput(ctx.run.id, 'clickup.onboarding_list'))?.output ?? null;

  const { desired } = trackerFieldValues(ctx, pkg, platform);
  const fields = await listFields(ctx, listId);
  const { values, unresolved } = resolveFields(fields, desired);
  if (!pkg) {
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'clickup.master_tracker',
      parsed_error: `package "${packageTextOf(ctx.run) || '(none)'}" does not match a known program - deliverable fields left blank`,
    });
  }
  if (unresolved.length > 0) {
    await ctx.logEvent({
      level: 'warn',
      endpoint: 'clickup.master_tracker',
      response_body: { reason: 'tracker fields/options not found in ClickUp', unresolved },
    });
  }

  const res = await callApi<any>(ctx, `${CU}/list/${listId}/task`, 'clickup.task.create', {
    method: 'POST',
    headers: authHeader(),
    json: {
      name: clientName(ctx),
      description: trackerDescription(ctx, listOut?.list_url as string | undefined),
      custom_fields: values,
    },
  });
  return {
    task_id: res.body?.id ?? null,
    package: pkg?.contractType ?? null,
    fields_set: values.length,
    fields_unresolved: unresolved,
  };
}

async function masterTrackerDry(ctx: StepContext): Promise<Record<string, unknown>> {
  const listId = config.clickup.masterTrackerListId();
  await callApi(ctx, `${CU}/list/${listId}`, 'clickup.list.get', { headers: authHeader() });
  const pkg = packageOf(packageTextOf(ctx.run));
  const { desired } = trackerFieldValues(ctx, pkg, undefined);
  const { values, unresolved } = resolveFields(await listFields(ctx, listId), desired);
  return simulated({
    task_id: simId('task'),
    name: clientName(ctx),
    package: pkg?.contractType ?? null,
    fields_set: values.length,
    fields_unresolved: unresolved,
  });
}

export const clickupSteps: Step[] = [
  {
    key: 'clickup.clone_template', wave: 1, safetyClass: 'reversible-write', dependsOn: [], maxAttempts: 3,
    isApplicable: () => true, runReal: cloneTemplateReal, runDry: cloneTemplateDry,
  },
  {
    // Practice Pro only - the other programs have no onboarding sample list yet.
    key: 'clickup.onboarding_list', wave: 1, safetyClass: 'reversible-write',
    dependsOn: ['profile.normalize_intake'], maxAttempts: 3,
    isApplicable: (run) => isPracticePro(packageTextOf(run)),
    runReal: onboardingListReal, runDry: onboardingListDry,
  },
  {
    key: 'clickup.master_tracker', wave: 1, safetyClass: 'reversible-write',
    dependsOn: ['clickup.clone_template', 'profile.normalize_intake'],
    // Ordering only: the tracker row links the onboarding list and records the
    // detected CMS, but must still be created if either of those failed.
    softDependsOn: ['clickup.onboarding_list', 'crawl.detect_platform'],
    maxAttempts: 3,
    isApplicable: () => true, runReal: masterTrackerReal, runDry: masterTrackerDry,
  },
];
