/**
 * cloud-backup — index.js — v1.2.0
 *
 * Changes from v1.1.0:
 *   - onSave(change): uses provider.refreshCreds(storage) instead of
 *     loadCreds() so expired tokens are silently renewed and saved before
 *     enqueueing. Same fix in onSave(autosave).
 *   - onSave(autosave) uploadFn: passes freshCreds (post-refresh) to
 *     provider.upload() so the upload itself never needs to refresh again.
 *   - onConflict: stores conflict context in extension storage before
 *     navigating, so ConflictResolution.js can read it via the API bridge.
 *     Previously the context was passed as the session argument and lost.
 */

import { UploadQueue }                      from './queue.js';
// ErrorLogger is a host-app module — import via the bridge rather than directly,
// since the extension runs as a raw ES module without webpack. We use a simple
// console.error wrapper here; the host's ErrorLogger picks it up via the WebView console.
import { GDriveProvider }                   from './gdrive.js';
import { WebDAVProvider }                   from './webdav.js';
import { DropboxProvider, OneDriveProvider } from './dropbox_onedrive.js';

const PROVIDERS = {
  gdrive:   new GDriveProvider(),
  onedrive: new OneDriveProvider(),
  dropbox:  new DropboxProvider(),
  webdav:   new WebDAVProvider(),
};

export function activate({ registerHook, storage, navigate, extension }) {
  const queue = new UploadQueue(storage);

  // Reset any permanently-failed entries from the previous session so they
  // get one fresh attempt on this app start (answers Q3).
  queue.resetFailed().then(changed => {
    if (changed) console.info('[cloud-backup] Retrying previously failed uploads on app start');
  }).catch(e => console.error('[cloud-backup] resetFailed error:', e));

  async function getActiveProvider() {
    const key = await storage.get('activeProvider');
    return key ? PROVIDERS[key] ?? null : null;
  }

  // ── onSave(change) — mark session dirty ──────────────────────────────────
  const unregChange = registerHook('onSave', async ({ session, trigger }) => {
    if (trigger !== 'change') return;

    const provider = await getActiveProvider();
    if (!provider) return;

    // refreshCreds = load + refresh if expired + save back + return
    const creds = await provider.refreshCreds(storage);
    if (!creds) return;

    await queue.enqueue(session, provider.id);
    updateTileStatus(queue);
  });

  // ── onSave(autosave) — process queue ─────────────────────────────────────
  const unregAutosave = registerHook('onSave', async ({ session, trigger }) => {
    if (trigger !== 'autosave') return;

    const provider = await getActiveProvider();
    if (!provider) return;

    // Refresh once before the entire queue run; save the fresh token back.
    const freshCreds = await provider.refreshCreds(storage);
    if (!freshCreds) return;

    await queue.process(
      async (entry) => {
        const entrySession = entry.sessionId === session.id ? session : null;
        if (!entrySession) {
          return { ok: false, error: 'session not available in this cycle' };
        }

        const api = window.AuthNoExtensionAPI;
        if (!api?.encodeSession) throw new Error('AuthNoExtensionAPI.encodeSession not available');
        const base64 = await api.encodeSession(entrySession);

        // Pass freshCreds — already refreshed and saved, upload won't refresh again
        return provider.upload(entry, freshCreds, base64);
      },
      async (entry, cloudModified) => {
        console.warn(`[cloud-backup] conflict on ${entry.title} — cloud modified ${cloudModified}`);

        // Store conflict context in extension storage so ConflictResolution.js
        // can read it via the API bridge (it has no other way to receive data).
        await storage.set('conflictContext', JSON.stringify({
          sessionId:    entry.sessionId,
          title:        entry.title,
          cloudModified,
          providerName: provider.name,
        }));

        navigate(extension, 'conflict', null);
      }
    );

    updateTileStatus(queue);
  });

  // ── Homescreen tile status ────────────────────────────────────────────────
  async function updateTileStatus(q) {
    const status = await q.statusSummary();
    await storage.set('tileStatus', status);
  }

  // ── Public surface for UI pages ───────────────────────────────────────────
  window.CloudBackupAPI = {
    providers: PROVIDERS,
    queue,
    storage,
    navigate,
    extension,

    async getStatus() {
      return {
        activeProvider: await storage.get('activeProvider'),
        tileStatus:     await storage.get('tileStatus') ?? 'synced',
        queueEntries:   await queue.all(),
      };
    },

    async connectProvider(providerKey, config) {
      const provider = PROVIDERS[providerKey];
      if (!provider) throw new Error(`Unknown provider: ${providerKey}`);
      const creds = await provider.connect(config);
      await provider.saveCreds(storage, creds);
      await storage.set('activeProvider', providerKey);
    },

    async disconnectProvider() {
      const provider = await getActiveProvider();
      if (provider) await provider.disconnect(storage);
      await storage.set('activeProvider', null);
      await queue.clear();
      await storage.set('tileStatus', 'synced');
    },

    async resolveConflict(sessionId, resolution) {
      if (resolution === 'keep-local') {
        const provider = await getActiveProvider();
        if (provider) await queue.enqueue({ id: sessionId }, provider.id);
      }
    },
  };

  return function deactivate() {
    unregChange();
    unregAutosave();
    delete window.CloudBackupAPI;
  };
}
