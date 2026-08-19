/**
 * pageApi.js — what a settings page is allowed to do.
 *
 * A v2 UI page is its own frame with its own opaque origin. It cannot see the
 * background half's memory, and there is no `window.CloudBackupAPI` for it to
 * read — v1 hung one on the page and every page reached into it.
 *
 * Two channels replace it, and which one a call uses is the whole design:
 *
 *   **Straight to the host** for anything the page may do itself. `authno` is
 *   the same object the background half has, routed through the same dispatch,
 *   so a page is governed by the same grants. Listing books, exporting one,
 *   navigating, a toast.
 *
 *   **Through the background half** for anything involving credentials. A page
 *   never sees an access token. v1's pages did: `API.storage.get('creds:...')`,
 *   `JSON.parse`, then `provider.download(id, creds)` — so a Dropbox token
 *   lived in the settings frame, the conflict frame and the file picker. Those
 *   calls are now named operations, and the tokens stay where they are made.
 *
 * The second channel is storage: one key holds a request, another the answer.
 * Slower than a function call and unmistakably a boundary, which is the trade.
 */

const REQUEST_KEY = '__request';
const RESPONSE_KEY = '__response';

/** How long to wait for the background half before giving up. */
const REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_POLL_MS = 120;

let seq = 0;

export function createPageApi(authno) {
  const { storage } = authno;

  /**
   * Ask the background half to do something, and wait for its answer.
   *
   * The id is what makes an answer match its question. Without it a page that
   * asked twice would read the first reply as the second's — which is exactly
   * how a "Sync now" tap ends up reporting the previous run's error.
   */
  async function request(name, args = {}) {
    const id = `${Date.now()}-${++seq}`;
    await storage.setJSON(REQUEST_KEY, { id, name, args });

    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    for (;;) {
      const res = await storage.getJSON(RESPONSE_KEY, null);
      if (res && res.id === id) {
        if (res.error) throw new Error(res.error);
        return res.result;
      }
      if (Date.now() > deadline) {
        throw new Error('Cloud Backup did not answer. It may not be running.');
      }
      await new Promise((r) => setTimeout(r, REQUEST_POLL_MS));
    }
  }

  return {
    // ── Straight to the host ──────────────────────────────────────────────
    storage,
    navigate: (pageId, session) => authno.ui.navigate(pageId, session ?? null),
    close: () => authno.close(),
    toast: (message, opts) => authno.ui.toast(message, opts),
    getSessions: () => authno.library.list(),
    exportSessionAs: (sessionId, format) => authno.library.exportAs(sessionId, format),
    importSession: (base64) => authno.library.create({ data: base64 }),

    // ── Through the background half, because credentials are involved ─────
    getStatus: () => request('getStatus'),
    connectProvider: (providerKey, config) => request('connectProvider', { providerKey, config }),
    disconnectProvider: () => request('disconnectProvider'),
    syncNow: () => request('syncNow'),
    resolveConflict: (sessionId, resolution) => request('resolveConflict', { sessionId, resolution }),
    listCloudFiles: () => request('listCloudFiles'),
    downloadCloudFile: (sessionId) => request('downloadCloudFile', { sessionId }),
    restoreFromCloud: (sessionId) => request('restoreFromCloud', { sessionId }),
    exportToCloud: (sessionId, format) => request('exportToCloud', { sessionId, format }),
    isBookBackupDisabled: (sessionId) => request('isBookBackupDisabled', { sessionId }),
    setBookBackupDisabled: (sessionId, disabled) =>
      request('setBookBackupDisabled', { sessionId, disabled }),
  };
}

/**
 * The api object for this page.
 *
 * `window.authno` is set by the host's page shim before any extension module
 * runs, so it is there by the time this module body executes. If it is not,
 * the page is being loaded some way this extension does not support, and
 * saying so beats a TypeError on the first property access.
 */
export const API = (() => {
  if (typeof window === 'undefined' || !window.authno) {
    throw new Error('This page needs AuthNo 1.1.20 or newer.');
  }
  return createPageApi(window.authno);
})();
