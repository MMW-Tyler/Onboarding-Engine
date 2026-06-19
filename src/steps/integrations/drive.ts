import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi } from '../../lib/http.js';
import { config } from '../../config.js';
import { getGoogleAccessToken } from '../../lib/google.js';
import { profileOf, simId, simulated } from './util.js';

/**
 * Google Drive worker (spec section 08: drive.create_folders).
 * Creates a root client folder under the configured parent, then a standard set
 * of numbered subfolders inside it.
 *
 * Auth is done via src/lib/google.ts (hand-rolled JWT exchange) to avoid the
 * googleapis/gtoken "Premature close" transport bug. Drive REST calls go through
 * the shared callApi helper, so each one is logged to step_events.
 *
 * Open item (spec section 17, item 1): confirm the exact subfolder list against
 * a real client folder before going live. The list below is a working draft.
 */
const SUBFOLDERS = [
  '01 Sales & Onboarding',
  '02 Client Profile',
  '03 Branding & Assets',
  '04 Website',
  '05 SEO',
  '06 Content & Blog',
  '07 Social Media',
  '08 Email & Newsletters',
  '09 Ads',
  '10 Reviews & Reputation',
  '11 Reporting',
  '12 Restricted (sensitive)',
  '13 Misc',
];

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';

function rootName(ctx: StepContext): string {
  return (ctx.run.client_name as string) || profileOf(ctx.run).office_name || ctx.run.id;
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await getGoogleAccessToken(config.drive.saJson());
  return { authorization: `Bearer ${token}` };
}

/** Create one folder and return its id. supportsAllDrives covers shared drives. */
async function createFolder(ctx: StepContext, headers: Record<string, string>, name: string, parent: string): Promise<string> {
  const res = await callApi<any>(ctx, `${FILES_URL}?fields=id&supportsAllDrives=true`, 'drive.files.create', {
    method: 'POST',
    headers,
    json: { name, mimeType: FOLDER_MIME, parents: [parent] },
  });
  return res.body?.id as string;
}

// --- create_folders ---
async function createFoldersReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const headers = await authHeader();
  const rootId = await createFolder(ctx, headers, rootName(ctx), config.drive.parentFolderId());

  for (const name of SUBFOLDERS) {
    await createFolder(ctx, headers, name, rootId);
  }

  await db()
    .from('onboarding_runs')
    .update({ drive_root_folder_id: rootId, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  return { root_folder_id: rootId, subfolders: SUBFOLDERS.length };
}

async function createFoldersDry(ctx: StepContext): Promise<Record<string, unknown>> {
  // Validate credentials with a real token exchange; create nothing.
  try {
    await getGoogleAccessToken(config.drive.saJson());
    await ctx.logEvent({ level: 'info', endpoint: 'drive.auth', response_body: { ok: true } });
  } catch (err) {
    throw new Error(`drive.auth failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return simulated({ root_folder_id: simId('folder'), subfolders: SUBFOLDERS.length });
}

export const driveSteps: Step[] = [
  {
    key: 'drive.create_folders',
    wave: 1,
    safetyClass: 'reversible-write',
    dependsOn: [],
    maxAttempts: 3,
    isApplicable: () => true,
    runReal: createFoldersReal,
    runDry: createFoldersDry,
  },
];
