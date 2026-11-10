import type { Step, StepContext } from '../../types.js';
import { db } from '../../supabase.js';
import { callApi, HttpError } from '../../lib/http.js';
import { config } from '../../config.js';
import { getGoogleAccessToken, googleClientEmail } from '../../lib/google.js';
import { profileOf, simId, simulated } from './util.js';

/**
 * Google Drive worker (spec section 08: drive.create_folders).
 * Clones the template client folder: creates a root client folder under the
 * configured parent, then recreates the template's subfolders and copies its
 * files (the "Passwords - [client name].xlsx" sheet) into the new root. The
 * literal "[client name]" placeholder in any folder/file name is replaced with
 * the real client name.
 *
 * Drive's API cannot deep-copy a folder, so we list the template's immediate
 * children and recreate folders / files.copy files one level deep (which is all
 * the template has).
 *
 * Auth is done via src/lib/google.ts (hand-rolled JWT exchange) to avoid the
 * googleapis/gtoken "Premature close" transport bug. Drive REST calls go through
 * the shared callApi helper, so each one is logged to step_events.
 */
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const PLACEHOLDER = /\[client name\]/gi;

interface DriveChild {
  id: string;
  name: string;
  mimeType: string;
}

function rootName(ctx: StepContext): string {
  return (ctx.run.client_name as string) || profileOf(ctx.run).office_name || ctx.run.id;
}

/** Swap the "[client name]" placeholder used in template names for the real name. */
function applyName(name: string, clientName: string): string {
  return name.replace(PLACEHOLDER, clientName);
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

/** Copy one file into a new parent, returning the copy's id. */
async function copyFile(ctx: StepContext, headers: Record<string, string>, fileId: string, name: string, parent: string): Promise<string> {
  const res = await callApi<any>(ctx, `${FILES_URL}/${fileId}/copy?fields=id&supportsAllDrives=true`, 'drive.files.copy', {
    method: 'POST',
    headers,
    json: { name, parents: [parent] },
  });
  return res.body?.id as string;
}

/** List the template folder's immediate children (folders + files). */
async function listChildren(ctx: StepContext, headers: Record<string, string>, parentId: string): Promise<DriveChild[]> {
  const q = encodeURIComponent(`'${parentId}' in parents and trashed = false`);
  const url =
    `${FILES_URL}?q=${q}&fields=files(id,name,mimeType)&pageSize=200` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await callApi<any>(ctx, url, 'drive.files.list', { method: 'GET', headers });
  return (res.body?.files ?? []) as DriveChild[];
}

/**
 * Reuse a folder already set on the run instead of cloning the template again.
 * Set by the intake webhook for a returning client (their existing folder), or
 * by an earlier successful attempt of this step - which also makes a re-run
 * stop creating a second folder, as rerunRun's notes always assumed it did.
 *
 * Nothing is added to the reused folder: an existing client's folder has its
 * own layout, and dropping the template's ten subfolders into it would only
 * make a mess the team then has to tidy.
 */
async function reuseFolder(ctx: StepContext, headers: Record<string, string>, folderId: string): Promise<Record<string, unknown>> {
  let file: { id?: string; name?: string; mimeType?: string; trashed?: boolean } = {};
  try {
    const res = await callApi<any>(
      ctx,
      `${FILES_URL}/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`,
      'drive.files.get',
      { method: 'GET', headers },
    );
    file = res.body ?? {};
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 403)) {
      // Do NOT fall back to creating a new folder: a duplicate folder is the
      // thing this path exists to prevent. Flag with the fix instead.
      throw new Error(
        `drive: the existing folder ${folderId} is not visible to the service account. Share it with ` +
          `${googleClientEmail(config.drive.saJson())} (Editor), then retry this step.`,
      );
    }
    throw err;
  }
  if (file.mimeType !== FOLDER_MIME) throw new Error(`drive: ${folderId} is not a folder (${file.mimeType ?? 'unknown type'}). Fix the link on the run and retry.`);
  if (file.trashed) throw new Error(`drive: folder "${file.name ?? folderId}" is in the trash. Restore it, then retry this step.`);
  return { root_folder_id: folderId, reused: true, folder_name: file.name ?? null };
}

// --- create_folders ---
async function createFoldersReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const headers = await authHeader();
  const preset = ctx.run.drive_root_folder_id as string | undefined;
  if (preset) return reuseFolder(ctx, headers, preset);

  const clientName = rootName(ctx);
  const rootId = await createFolder(ctx, headers, clientName, config.drive.parentFolderId());

  const children = await listChildren(ctx, headers, config.drive.templateFolderId());

  const subfolders: string[] = [];
  const copiedFiles: string[] = [];
  for (const child of children) {
    const name = applyName(child.name, clientName);
    if (child.mimeType === FOLDER_MIME) {
      await createFolder(ctx, headers, name, rootId);
      subfolders.push(name);
    } else {
      await copyFile(ctx, headers, child.id, name, rootId);
      copiedFiles.push(name);
    }
  }

  await db()
    .from('onboarding_runs')
    .update({ drive_root_folder_id: rootId, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  return {
    root_folder_id: rootId,
    subfolders: subfolders.length,
    subfolder_names: subfolders,
    copied_files: copiedFiles,
  };
}

async function createFoldersDry(ctx: StepContext): Promise<Record<string, unknown>> {
  // Reusing only reads the folder's metadata, so a dry run checks it for real:
  // that is where "the service account can't see it" shows up.
  const preset = ctx.run.drive_root_folder_id as string | undefined;
  if (preset) return simulated(await reuseFolder(ctx, await authHeader(), preset));

  // Validate credentials with a real token exchange; create nothing. Also list
  // the template so the dry run surfaces what would be cloned.
  let subfolders = 0;
  let copiedFiles = 0;
  try {
    const headers = await authHeader();
    await ctx.logEvent({ level: 'info', endpoint: 'drive.auth', response_body: { ok: true } });
    const children = await listChildren(ctx, headers, config.drive.templateFolderId());
    subfolders = children.filter((c) => c.mimeType === FOLDER_MIME).length;
    copiedFiles = children.length - subfolders;
  } catch (err) {
    throw new Error(`drive.auth failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return simulated({ root_folder_id: simId('folder'), subfolders, copied_files: copiedFiles });
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
