/**
 * sync.js — bidirectional sync engine — v2.0.0
 *
 * What changed for v2, and why each change is not cosmetic:
 *
 * 1. **The host is passed in, not reached for.** v1 read
 *    `window.AuthNoExtensionAPI` from inside the frame. There is no such global
 *    now — a v2 extension runs in a sandboxed frame with an opaque origin and
 *    exactly one way out, so the host object arrives as an argument and every
 *    call on it is one the user granted a permission for.
 *
 * 2. **`library.list()` returns metadata, never chapters.** v1's `getSessions()`
 *    handed over whole sessions, which is why the poll below could read
 *    `updated` straight off them. The projection still carries `id`, `title`
 *    and `updated`, so the poll is unchanged in substance — but nothing here
 *    can see a manuscript any more, and the download path has to ask for the
 *    book explicitly.
 *
 * 3. **The RC-8 `Promise.resolve()` wrapper is gone**, not because the bug is
 *    gone but because it cannot recur: every v2 host call is a postMessage
 *    round trip, so `library.list()` is a Promise by construction rather than
 *    by whether the host happened to be a Capacitor bridge that day. The v1
 *    fix was working around an interface that was sometimes sync and sometimes
 *    not; v2 does not have one.
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const SYNC_KEY = 'syncState';             // storage key for per-session sync metadata

/**
 * How far apart two timestamps must be before they count as different edits.
 *
 * Clock skew between a phone and a cloud provider is routinely a second or
 * two, and a file's stored mtime is rounded. Without this margin a book that
 * nobody touched reads as changed on both sides and raises a conflict dialog
 * for a difference nobody made.
 */
const SKEW_MS = 5000;

let _pollTimer = null;
let _progressCb = null;

export function onProgress(cb) { _progressCb = cb; }

function emit(event) {
  if (_progressCb) _progressCb(event);
}

export function startPolling(ctx) {
  stopPolling();
  _poll(ctx);
  _pollTimer = setInterval(() => { _poll(ctx); }, POLL_INTERVAL_MS);
}

export function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

export async function pollNow(ctx) {
  return _poll(ctx);
}

/**
 * @param {object}   ctx
 * @param {object}   ctx.authno          the v2 host API
 * @param {object}   ctx.storage         authno.storage, passed separately because
 *                                       every line here uses it
 * @param {object}   ctx.providers       key → provider
 * @param {Function} ctx.getActiveCreds  () => creds | null
 * @param {Function} ctx.onImport        (base64) => void
 * @param {Function} ctx.onConflict      (entry, cloudModified) => void
 */
async function _poll({ authno, storage, providers, getActiveCreds, onImport, onConflict }) {
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

  // Metadata for every book. This needs library:read:all — with only
  // read:current there is no list, and the extension backs up one book.
  let books;
  try {
    books = await authno.library.list();
  } catch (err) {
    // A refusal is a real answer, not an outage: the user declined the
    // permission, or revoked it. Saying "offline" would send them looking at
    // their wifi.
    emit({ phase: 'denied', error: err.message });
    return;
  }

  if (!books.length) { emit({ phase: 'done', current: 0, total: 0 }); return; }

  const total = books.length;
  let current = 0;

  for (const { id: sessionId, title, updated } of books) {
    current++;
    emit({ phase: 'checking', current, total, sessionTitle: title });

    const syncState = (await storage.getJSON(`${SYNC_KEY}:${sessionId}`, {})) ?? {};
    const lastUploadedAt = syncState.lastUploadedAt ?? null;

    try {
      // Check cloud metadata without downloading
      const remoteMeta = await provider.getFileMeta(sessionId, creds).catch(() => null);
      if (!remoteMeta) continue; // file doesn't exist in cloud yet

      const remoteTime = new Date(remoteMeta.modifiedTime).getTime();
      const localTime  = updated ? new Date(updated).getTime() : 0;
      const uploadTime = lastUploadedAt ? new Date(lastUploadedAt).getTime() : 0;

      // Cloud is newer than our last upload AND newer than local modified time
      if (remoteTime > uploadTime + SKEW_MS && remoteTime > localTime + SKEW_MS) {
        // Both sides moved since the last sync — only the user can say which wins
        if (localTime > uploadTime + SKEW_MS) {
          onConflict({ sessionId, title }, remoteMeta.modifiedTime);
          continue;
        }

        // Cloud is authoritative — download
        emit({ phase: 'downloading', current, total, sessionTitle: title });
        const { base64 } = await provider.download(sessionId, creds);
        await onImport(base64, sessionId);

        syncState.lastDownloadedAt = new Date().toISOString();
        await storage.setJSON(`${SYNC_KEY}:${sessionId}`, syncState);
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
  const state = (await storage.getJSON(`${SYNC_KEY}:${sessionId}`, {})) ?? {};
  state.lastUploadedAt = new Date().toISOString();
  await storage.setJSON(`${SYNC_KEY}:${sessionId}`, state);
}
