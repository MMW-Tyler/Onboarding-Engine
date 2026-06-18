import type { Step, StepContext } from '../../types.js';
import { google } from 'googleapis';
import { db } from '../../supabase.js';
import { config } from '../../config.js';
import { simId, simulated } from './util.js';

/**
 * Google Drive worker (spec section 08: drive.create_folders).
 * Creates a root client folder under the configured parent, then creates a
 * standard set of numbered subfolders inside it.
 *
 * Open item (spec section 17, item 1): confirm the exact subfolder list against
 * a real client folder structure before going live. The list below is a working
 * draft.
 */

// Draft subfolder list -- confirm against a live client folder (spec §17 item 1).
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

/** Build an authenticated Drive v3 client from the service-account JSON. */
function driveClient() {
  const creds = JSON.parse(config.drive.saJson());
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// --- create_folders ---

async function createFoldersReal(ctx: StepContext): Promise<Record<string, unknown>> {
  const drive = driveClient();
  const rootName = (ctx.run.client_name as string) || ctx.run.id;

  // Create the root client folder under the shared parent.
  const rootRes = await drive.files.create({
    requestBody: {
      name: rootName,
      mimeType: FOLDER_MIME,
      parents: [config.drive.parentFolderId()],
    },
    fields: 'id',
  });
  const rootId = rootRes.data.id as string;
  await ctx.logEvent({ level: 'info', endpoint: 'drive.files.create', response_body: { name: rootName, id: rootId } });

  // Create each subfolder inside the root.
  for (const name of SUBFOLDERS) {
    const res = await drive.files.create({
      requestBody: {
        name,
        mimeType: FOLDER_MIME,
        parents: [rootId],
      },
      fields: 'id',
    });
    await ctx.logEvent({ level: 'info', endpoint: 'drive.files.create', response_body: { name, id: res.data.id } });
  }

  // Persist the root folder id on the run so downstream steps can reference it.
  await db()
    .from('onboarding_runs')
    .update({ drive_root_folder_id: rootId, updated_at: new Date().toISOString() })
    .eq('id', ctx.run.id);

  return { root_folder_id: rootId, subfolders: SUBFOLDERS.length };
}

async function createFoldersDry(ctx: StepContext): Promise<Record<string, unknown>> {
  // Validate credentials by attempting a real OAuth token exchange; no files created.
  const creds = JSON.parse(config.drive.saJson());
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  try {
    await auth.authorize();
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
