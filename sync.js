/**
 * sync.js — bidirectional sync engine — v1.4.0
 *
 * Changes from v1.3.0:
 *   - RC-8 FIX: _poll() now awaits api.getSessions() via Promise.resolve()
 *     wrapping.  Previously the result was used synchronously; if the host
 *     app's AuthNoExtensionAPI.getSessions() returns a Promise (as all
 *     Capacitor bridge methods do), `sessions` was a Promise object,
 *     `sessions.length` was undefined (the early-return check silently
 *     passed), and the for…of loop iterated zero items.  Sync polling
 *     appeared to succeed but checked nothing.
 *
 *     Promise.resolve() wrapping is safe whether the host returns a plain
 *     array (synchronous) or a Promise (asynchronous).
 *
 * Changes from v1.2.3 → v1.3.0 (preserved):
 *   - onConflict(): fixed call signature from onConflict(oneObject) to
 *     onConflict(entry, cloudModified) to match all callers in index.js.
 *     Previously cloudModified was always undefined in conflictContext.
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const SYNC_KEY = 'syncState';             // storage key for per-session sync metadata

let _pollTimer = null;
let _progressCb = null;

export function onProgress(cb) { _progressCb = cb; }

function emit(event) {
  if (_progressCb) _progressCb(event);
}

export function startPolling(storage, providers, getActiveCreds, onImport, onConflict) {
  stopPolling();
  _poll(storage, providers, getActiveCreds, onImport, onConflict);
  _pollTimer = setInterval(() => {
    _poll(storage, providers, getActiveCreds, onImport, onConflict);
  }, POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

export async function pollNow(storage, providers, getActiveCreds, onImport, onConflict) {
  return _poll(storage, providers, getActiveCreds, onImport, onConflict);
}

async function _poll(storage, providers, getActiveCreds, onImport, onConflict) {
  const providerKey = await storage.get('activeProvider');
  if (!providerKey) return;

  const provider = providers[providerKey];
  if (!provider) return;

  let creds;
  try {
    creds = await getActiveCreds();
    if (!creds) return;
  } catch {
    emit({ phase: 'offline' });
    return;
  }

  // Get all sessions from the host app
  const api = window.AuthNoExtensionAPI;
  if (!api?.getSessions) return;

  // ── RC-8 FIX: await getSessions ──────────────────────────────────────────
  // AuthNoExtensionAPI.getSessions() may return a Promise (Capacitor bridges
  // are async). Without await, sessions was a Promise object; sessions.length
  // was undefined; the for…of loop never ran; sync polling was silently a
  // no-op.  Promise.resolve() is safe for both sync and async implementations.
  const sessions = await Promise.resolve(api.getSessions());
  // ─────────────────────────────────────────────────────────────────────────

  if (!sessions.length) { emit({ phase: 'done', current: 0, total: 0 }); return; }

  const total = sessions.length;
  let current = 0;

  for (const { id: sessionId, title, updated } of sessions) {
    current++;
    emit({ phase: 'checking', current, total, sessionTitle: title });

    // Load stored sync state for this session
    let syncState = {};
    try {
      const raw = await storage.get(`${SYNC_KEY}:${sessionId}`);
      if (raw) syncState = JSON.parse(raw);
    } catch {}

    const lastUploadedAt   = syncState.lastUploadedAt ?? null;

    try {
      // Check cloud metadata without downloading
      const remoteMeta = await provider.getFileMeta(sessionId, creds).catch(() => null);
      if (!remoteMeta) continue; // file doesn't exist in cloud yet

      const remoteTime = new Date(remoteMeta.modifiedTime).getTime();
      const localTime  = updated ? new Date(updated).getTime() : 0;
      const uploadTime = lastUploadedAt ? new Date(lastUploadedAt).getTime() : 0;

      // Cloud is newer than our last upload AND newer than local modified time
      if (remoteTime > uploadTime + 5000 && remoteTime > localTime + 5000) {
        // Conflict: both local and cloud have been modified since last sync
        if (localTime > uploadTime + 5000) {
          onConflict({ sessionId, title }, remoteMeta.modifiedTime);
          continue;
        }

        // Cloud is authoritative — download
        emit({ phase: 'downloading', current, total, sessionTitle: title });
        const { base64 } = await provider.download(sessionId, creds);
        await onImport(base64);

        // Record download time
        syncState.lastDownloadedAt = new Date().toISOString();
        await storage.set(`${SYNC_KEY}:${sessionId}`, JSON.stringify(syncState));
      }
    } catch (err) {
      console.error(`[cloud-backup] sync poll error for "${title}":`, err.message);
      emit({ phase: 'error', sessionTitle: title, error: err.message });
    }
  }

  emit({ phase: 'done', current: total, total });
}

/** Record a successful upload for a session so polling knows the baseline. */
export async function recordUpload(storage, sessionId) {
  const raw = await storage.get(`${SYNC_KEY}:${sessionId}`).catch(() => null);
  const state = raw ? JSON.parse(raw) : {};
  state.lastUploadedAt = new Date().toISOString();
  await storage.set(`${SYNC_KEY}:${sessionId}`, JSON.stringify(state));
}
