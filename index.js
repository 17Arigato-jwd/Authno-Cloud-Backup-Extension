/**
 * cloud-backup — index.js — v1.4.0
 *
 * Changes from v1.3.0:
 *   - Removed OneDrive provider.
 *   - Fixed resolveConflict('use-cloud'): was a complete no-op — now downloads
 *     the cloud version and imports it via AuthNoExtensionAPI.
 *   - Fixed onConflict signature mismatch: sync.js called onConflict(oneObject)
 *     but handlers expected (entry, cloudModified) — cloudModified was always
 *     undefined in conflictContext, breaking ConflictResolution.js date display.
 *   - Fixed recordUpload: now called after each successful upload so the sync
 *     engine has an accurate lastUploadedAt baseline, preventing spurious
 *     re-downloads on the next poll.
 *   - Added to CloudBackupAPI: getSessions, importSession, exportSessionAs,
 *     syncNow — required by Settings.js, CloudFilePicker.js.
 *   - Extracted shared handleConflict / handleImport / getActiveCreds helpers
 *     to eliminate duplicated inline lambdas in pollNow calls.
 *
 * Changes from v1.3.0 → v1.4.0:
 *   - RC-3 FIX: queue uploadFn now returns { skip: true } (not { ok: false,
 *     error: '...' }) for sessions that aren't this autosave's session, so
 *     queue.process() does not increment attempts on unrelated entries.
 *   - RC-4 FIX (cold-start): activate() now checks sessionStorage for a
 *     pending PKCE flow and — if one exists — retrieves the launch URL via
 *     Capacitor.Plugins.App.getLaunchUrl() and re-dispatches
 *     __capacitor_app_url_open so the pkceOAuthFlow handler can complete the
 *     exchange even when the app was cold-started by the redirect.
 *   - RC-7 FIX: resolveConflict('keep-local') now re-enqueues with { id,
 *     title, filePath } read from conflictContext storage, not just { id }.
 *   - Removed dead googleSignIn bridge — GDriveProvider.connect() now uses
 *     pkceOAuthFlow directly (same pattern as Dropbox).  Keeping the bridge
 *     would have left an unreachable code path that could confuse future
 *     callers.
 */

import { UploadQueue }                         from './queue.js';
import { startPolling, stopPolling, onProgress, recordUpload, pollNow } from './sync.js';
import { GDriveProvider }                      from './gdrive.js';
import { WebDAVProvider }                      from './webdav.js';
import { DropboxProvider }                     from './dropbox_onedrive.js';

const PROVIDERS = {
  gdrive:  new GDriveProvider(),
  dropbox: new DropboxProvider(),
  webdav:  new WebDAVProvider(),
};

export function activate({ registerHook, storage, navigate, extension, openBrowser, closeBrowser }) {
  const queue = new UploadQueue(storage);

  // Feature E: wire progress events to storage so Settings.js can poll them
  onProgress(async (event) => {
    await storage.set('syncProgress', JSON.stringify(event));
  });

  // ── RC-4 FIX: Cold-start OAuth resume ──────────────────────────────────────
  // If the app was killed while a PKCE flow was in progress, sessionStorage
  // holds the pending state. The redirect URL is available via getLaunchUrl().
  // Re-dispatch __capacitor_app_url_open so pkceOAuthFlow's handler can pick
  // it up and complete the token exchange.
  (async () => {
    try {
      const pending = sessionStorage.getItem('__pkce_pending');
      if (!pending) return;

      const appPlugin = window.Capacitor?.Plugins?.App;
      if (!appPlugin) return;

      const launchResult = await appPlugin.getLaunchUrl().catch(() => null);
      const url = launchResult?.url;
      if (!url) return;

      // Only re-dispatch if the URL matches a known redirect prefix
      const parsed = JSON.parse(pending);
      if (!url.startsWith(parsed.redirectUri)) return;

      // Give pkceOAuthFlow time to re-register its listener after module init
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('__capacitor_app_url_open', { detail: { url } })
        );
      }, 100);
    } catch (e) {
      console.warn('[cloud-backup] cold-start OAuth resume failed:', e.message);
    }
  })();
  // ──────────────────────────────────────────────────────────────────────────

  // ── Shared helpers ─────────────────────────────────────────────────────────

  async function getActiveProvider() {
    const key = await storage.get('activeProvider');
    return key ? PROVIDERS[key] ?? null : null;
  }

  async function getActiveCreds() {
    const p = await getActiveProvider();
    return p ? p.refreshCreds(storage) : null;
  }

  // Unified onConflict — called from both queue.process and sync polling.
  // Signature: (entry: { sessionId, title, filePath? }, cloudModified: string)
  async function handleConflict(entry, cloudModified) {
    const provider = await getActiveProvider();
    await storage.set('conflictContext', JSON.stringify({
      sessionId:    entry.sessionId,
      title:        entry.title,
      filePath:     entry.filePath ?? null,   // RC-7: persist for re-enqueue
      cloudModified,
      providerName: provider?.name ?? 'Cloud',
    }));
    navigate(extension, 'conflict', null);
  }

  // Unified onImport — called when a cloud download should be applied locally.
  async function handleImport(base64) {
    const api = window.AuthNoExtensionAPI;
    if (api?.importSession) await api.importSession(base64);
  }

  // ── Background sync polling ────────────────────────────────────────────────

  startPolling(storage, PROVIDERS, getActiveCreds, handleImport, handleConflict);

  // Reset permanently-failed entries on app start so they get one fresh attempt
  queue.resetFailed().then(changed => {
    if (changed) console.info('[cloud-backup] Retrying previously failed uploads on app start');
  }).catch(e => console.error('[cloud-backup] resetFailed error:', e));

  // ── onSave(change) — mark session dirty ───────────────────────────────────

  const unregChange = registerHook('onSave', async ({ session, trigger }) => {
    if (trigger !== 'change') return;

    const provider = await getActiveProvider();
    if (!provider) return;

    const creds = await provider.refreshCreds(storage);
    if (!creds) return;

    // Feature C: per-book opt-out
    const noBackup = await storage.get(`noBackup:${session.id}`);
    if (noBackup === 'true') return;

    await queue.enqueue(session, provider.id);
    updateTileStatus(queue);
  });

  // ── onSave(autosave) — process queue ──────────────────────────────────────

  const unregAutosave = registerHook('onSave', async ({ session, trigger }) => {
    if (trigger !== 'autosave') return;

    const provider = await getActiveProvider();
    if (!provider) return;

    // Refresh once before the full queue run; write back so token is persisted.
    const freshCreds = await provider.refreshCreds(storage);
    if (!freshCreds) return;

    await queue.process(
      async (entry) => {
        // ── RC-3 FIX ────────────────────────────────────────────────────────
        // Return { skip: true } instead of { ok: false, error: '...' }.
        // queue.process() will leave this entry completely untouched — no
        // attempt increment, no backoff — so it is retried next autosave cycle.
        if (entry.sessionId !== session.id) {
          return { ok: false, skip: true };
        }
        // ────────────────────────────────────────────────────────────────────

        const api = window.AuthNoExtensionAPI;
        if (!api?.encodeSession) throw new Error('AuthNoExtensionAPI.encodeSession not available');
        const base64 = await api.encodeSession(session);

        console.log(`[cloud-backup] autosave upload: "${entry.title}" (${Math.round(base64.length * 0.75 / 1024)} KB)`);
        const result = await provider.upload(entry, freshCreds, base64);

        if (result?.ok) {
          await recordUpload(storage, entry.sessionId);
          console.log(`[cloud-backup] autosave upload OK: "${entry.title}"`);
        }

        return result;
      },
      handleConflict
    );

    updateTileStatus(queue);

    // Immediate poll after uploads so bidirectional state is up to date
    await pollNow(storage, PROVIDERS, getActiveCreds, handleImport, handleConflict).catch(() => {});
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function updateTileStatus(q) {
    const status = await q.statusSummary();
    await storage.set('tileStatus', status);
  }

  // ── Public surface for UI pages ───────────────────────────────────────────

  window.CloudBackupAPI = {
    // Browser bridge — extensions run as raw ES modules, can't bare-import Capacitor
    openBrowser,
    closeBrowser,

    providers: PROVIDERS,
    queue,
    storage,
    navigate,
    extension,

    // ── Host-app API bridges ──────────────────────────────────────────────
    getSessions:     ()               => window.AuthNoExtensionAPI?.getSessions()            ?? [],
    importSession:   (b64)            => window.AuthNoExtensionAPI?.importSession(b64),
    exportSessionAs: (session, fmt)   => window.AuthNoExtensionAPI?.exportSessionAs(session, fmt),

    // NOTE: googleSignIn bridge removed. GDriveProvider now uses pkceOAuthFlow
    // (browser PKCE OAuth) the same way DropboxProvider does. The native
    // GoogleSignIn Capacitor plugin is no longer called from this extension.

    // ── Status & control ──────────────────────────────────────────────────

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

    // Trigger an immediate sync — called by the "Sync now" button.
    // Phase 1: queue every enabled book and upload them all to the cloud.
    // Phase 2: poll the cloud for any changes made on other devices.
    //
    // getSessions() now returns full session objects (App.js was updated to
    // pass the complete sessions array), so encodeSession() gets the chapters
    // it needs to produce a real .authbook file.
    async syncNow() {
      const provider = await getActiveProvider();
      if (provider) {
        let freshCreds;
        try { freshCreds = await provider.refreshCreds(storage); } catch { freshCreds = null; }

        if (freshCreds) {
          // Enqueue every session that hasn't been opted out
          const sessions = await Promise.resolve(window.AuthNoExtensionAPI?.getSessions() ?? []);
          for (const session of sessions) {
            const noBackup = await storage.get(`noBackup:${session.id}`);
            if (noBackup === 'true') continue;
            await queue.enqueue(session, provider.id);
          }
          updateTileStatus(queue);

          // Process the whole queue (no session-ID filter — upload everything)
          await queue.process(async (entry) => {
            const api = window.AuthNoExtensionAPI;
            if (!api?.encodeSession) throw new Error('AuthNoExtensionAPI.encodeSession not available');
            const allSessions = await Promise.resolve(api.getSessions() ?? []);
            const full = allSessions.find(s => s.id === entry.sessionId);
            if (!full) {
              console.warn(`[cloud-backup] syncNow: session "${entry.sessionId}" not found in getSessions() — skipping`);
              return { ok: false, skip: true };
            }
            console.log(`[cloud-backup] syncNow: encoding "${full.title ?? entry.sessionId}" (chapters: ${full.chapters?.length ?? 0})`);
            const base64 = await api.encodeSession(full);
            console.log(`[cloud-backup] syncNow: uploading "${full.title}" (${Math.round(base64.length * 0.75 / 1024)} KB)`);
            const result = await provider.upload(entry, freshCreds, base64);
            if (result?.ok) {
              await recordUpload(storage, entry.sessionId);
              console.log(`[cloud-backup] syncNow: upload OK — "${full.title}"`);
            }
            return result;
          }, handleConflict);

          updateTileStatus(queue);
        }
      }
      // Phase 2: download any cloud changes
      await pollNow(storage, PROVIDERS, getActiveCreds, handleImport, handleConflict);
    },

    async resolveConflict(sessionId, resolution) {
      const provider = await getActiveProvider();
      if (!provider) throw new Error('No active provider');

      if (resolution === 'keep-local') {
        // ── RC-7 FIX: re-enqueue with full session shape ─────────────────
        // Read title and filePath from conflictContext (written by handleConflict).
        // Previously: queue.enqueue({ id: sessionId }) — title always 'Untitled',
        // filePath always null.
        const raw = await storage.get('conflictContext').catch(() => null);
        const ctx = raw ? JSON.parse(raw) : {};
        await queue.enqueue(
          {
            id:       sessionId,
            title:    ctx.title    ?? 'Untitled',
            filePath: ctx.filePath ?? null,
          },
          provider.id,
        );
        // ─────────────────────────────────────────────────────────────────

      } else if (resolution === 'keep-local-no-upload') {
        // User wants to keep their local version but NOT push it to cloud.
        // Simply remove the conflicting entry from the queue so it's no
        // longer stuck — the cloud version is left untouched.
        await queue.removeSession(sessionId);

      } else if (resolution === 'use-cloud') {
        // Download the cloud version and import it into the app
        const creds = await provider.refreshCreds(storage);
        if (!creds) throw new Error('Not authenticated');
        const { base64 } = await provider.download(sessionId, creds);
        await handleImport(base64);
        await recordUpload(storage, sessionId);
      }
    },

    // Feature C — per-book backup toggle
    async isBookBackupDisabled(sessionId) {
      return (await storage.get(`noBackup:${sessionId}`)) === 'true';
    },
    async setBookBackupDisabled(sessionId, disabled) {
      await storage.set(`noBackup:${sessionId}`, disabled ? 'true' : null);
    },
  };

  return function deactivate() {
    stopPolling();
    unregChange();
    unregAutosave();
    delete window.CloudBackupAPI;
  };
}
