/**
 * cloud-backup — index.js — v2.0.0
 *
 * The port to extension API v2. What changed is not the sync logic — that is
 * the same queue, the same poll, the same conflict rule — but everything
 * around it, because v1 and v2 disagree about what an extension IS.
 *
 * ── What went away ───────────────────────────────────────────────────────────
 *
 * `window.AuthNoExtensionAPI`, `window.CloudBackupAPI`, `window.Capacitor`,
 * `sessionStorage`, and the `__capacitor_app_url_open` listener. Not renamed:
 * gone. A v2 extension runs in a frame with an opaque origin and exactly one
 * way out, so there is no `window` worth reading and no `parent` it can reach.
 * The host arrives as the argument to `activate()`, and every method on it is
 * a round trip the app can refuse.
 *
 * With them went the cold-start OAuth resume — thirty lines that existed
 * because the OS can kill an app while its user is on a consent screen, and
 * v1 owned the flow. The host owns it now, so there is nothing here to resume.
 *
 * ── What replaced the UI-page bridge ─────────────────────────────────────────
 *
 * v1 hung `window.CloudBackupAPI` on the page so Settings.js, CloudFilePicker
 * and ConflictResolution could call into the running extension. In v2 each
 * page is its own frame with its own opaque origin — there is no shared
 * `window` to hang anything on, and that is the point rather than an oversight.
 *
 * The pages talk to this half through `storage`, which both halves can reach
 * and neither can see the other's memory through. A page writes a request;
 * this half reads it, does the work, and writes the answer back. Slower than a
 * function call and unmistakably a boundary, which is the trade v2 is.
 *
 * ── What did NOT change ──────────────────────────────────────────────────────
 *
 * Every `fetch` in every provider. v2 enforces the network permission with the
 * frame's Content-Security-Policy rather than a bridge, so a request to a host
 * the manifest names simply works and one to a host it does not simply fails.
 * There is no `network.fetch` to route through and no wrapper to forget.
 */

import { UploadQueue } from './queue.js';
import { startPolling, stopPolling, onProgress, recordUpload, readUploadBaseline, pollNow } from './sync.js';
import { GDriveProvider } from './gdrive.js';
import { WebDAVProvider } from './webdav.js';
import { DropboxProvider } from './dropbox.js';

/**
 * How the settings pages ask this half to do something.
 *
 * A single storage key holding `{ id, name, args }`, and a second holding the
 * answer. The id makes a reply match its request — without it a page that
 * asked twice would read the first answer as the second's, which is how a
 * "Sync now" tap ends up reporting the previous run's error.
 */
const REQUEST_KEY = '__request';
const RESPONSE_KEY = '__response';
const REQUEST_POLL_MS = 400;

export function activate(authno) {
  const { storage } = authno;
  // The second argument is where a re-queued book gets its "last uploaded"
  // time from, now that the queue entry carrying it does not outlive the
  // upload. Same record the poll reads.
  const queue = new UploadQueue(storage, (id) => readUploadBaseline(storage, id));

  // Bound with storage as well as the host: a provider that renews a token
  // part way through a long operation has to be able to write it down, and
  // only the instance knows where. See BaseProvider.freshen.
  const PROVIDERS = {
    gdrive: new GDriveProvider().bind(authno, storage),
    dropbox: new DropboxProvider().bind(authno, storage),
    webdav: new WebDAVProvider().bind(authno, storage),
  };

  // Progress goes to storage so the settings page can read it. It is a
  // one-way report, not a channel: the page never writes here.
  onProgress(async (event) => {
    try { await storage.setJSON('syncProgress', event); } catch { /* a report, not the work */ }
  });

  // ── Shared helpers ─────────────────────────────────────────────────────────

  async function getActiveProvider() {
    const key = await storage.get('activeProvider');
    return key ? PROVIDERS[key] ?? null : null;
  }

  async function getActiveCreds() {
    const p = await getActiveProvider();
    return p ? p.refreshCreds(storage) : null;
  }

  /**
   * Both copies changed. Record what is needed to resolve it and ask.
   *
   * `filePath` is persisted alongside because 'keep-local' re-enqueues from
   * this record: without it every resolved conflict re-uploaded as "Untitled"
   * with no path.
   */
  async function handleConflict(entry, cloudModified) {
    const provider = await getActiveProvider();
    await storage.setJSON('conflictContext', {
      sessionId: entry.sessionId,
      title: entry.title,
      filePath: entry.filePath ?? null,
      cloudModified,
      providerName: provider?.name ?? 'Cloud',
    });
    await authno.ui.navigate('conflict');
  }

  /**
   * A book came down from the cloud; put it into the library.
   *
   * `library.create` rather than v1's `importSession`, and it needs
   * `library:write`. The app decides whether that is a new book or an update
   * to one it already has — this half only knows it holds bytes.
   */
  async function handleImport(base64) {
    return authno.library.create({ data: base64 });
  }

  /** A book, as bytes, ready to upload. Needs `library:export`. */
  async function encodeBook(sessionId) {
    const out = await authno.library.exportAs(sessionId, 'authbook');
    // exportAs answers { filename, base64, mimeType } for the file formats and
    // may answer bare base64 for authbook, depending on the app's exporter.
    const base64 = typeof out === 'string' ? out : out?.base64;
    if (!base64) throw new Error(`Could not read "${sessionId}" to back it up.`);
    return base64;
  }

  const syncCtx = {
    authno, storage, providers: PROVIDERS, getActiveCreds,
    onImport: handleImport, onConflict: handleConflict,
  };

  // ── Background sync polling ────────────────────────────────────────────────

  startPolling(syncCtx);

  // Give permanently-failed entries one fresh attempt per app start, so a book
  // that failed five times on a bad network is not stuck forever.
  queue.resetFailed().catch((e) => console.error('[cloud-backup] resetFailed:', e.message));

  // ── onSave(change) — mark a book dirty ────────────────────────────────────

  const unregChange = authno.registerHook('onSave', async ({ session, trigger }) => {
    if (trigger !== 'change') return;

    const provider = await getActiveProvider();
    if (!provider) return;
    if (!(await provider.refreshCreds(storage))) return;

    if ((await storage.get(`noBackup:${session.id}`)) === 'true') return;

    await queue.enqueue(session, provider.id);
    await updateTileStatus();
  });

  // ── onSave(autosave) — work the queue ─────────────────────────────────────

  const unregAutosave = authno.registerHook('onSave', async ({ session, trigger }) => {
    if (trigger !== 'autosave') return;

    const provider = await getActiveProvider();
    if (!provider) return;

    const freshCreds = await provider.refreshCreds(storage);
    if (!freshCreds) return;

    await queue.process(async (entry) => {
      // Not this autosave's book. `skip` rather than an error, or every
      // unrelated entry in the queue goes into exponential backoff for
      // something that was never wrong with it.
      if (entry.sessionId !== session.id) return { ok: false, skip: true };

      const base64 = await encodeBook(entry.sessionId);
      const result = await provider.upload(entry, freshCreds, base64);
      if (result?.ok) await recordUpload(storage, entry.sessionId);
      return result;
    }, handleConflict);

    await updateTileStatus();
    await pollNow(syncCtx).catch(() => {});
  });

  async function updateTileStatus() {
    await storage.set('tileStatus', await queue.statusSummary());
  }

  // ── The operations the settings pages can ask for ─────────────────────────

  const OPERATIONS = {
    async getStatus() {
      return {
        activeProvider: await storage.get('activeProvider'),
        tileStatus: (await storage.get('tileStatus')) ?? 'synced',
        queueEntries: await queue.all(),
      };
    },

    async listBooks() {
      return authno.library.list();
    },

    async connectProvider({ providerKey, config }) {
      const provider = PROVIDERS[providerKey];
      if (!provider) throw new Error(`Unknown provider: ${providerKey}`);
      const creds = await provider.connect(config);
      await provider.saveCreds(storage, creds);
      await storage.set('activeProvider', providerKey);
      // WebDAV sets this when the origin was granted but the policy in THIS
      // frame predates the grant. The app restarts the extension; the page
      // needs to know that "connected" here means "connected in a moment".
      return { pendingRestart: !!creds?._pendingRestart };
    },

    async disconnectProvider() {
      const provider = await getActiveProvider();
      const result = provider ? await provider.disconnect(storage) : null;
      await storage.set('activeProvider', null);
      await queue.clear();
      await storage.set('tileStatus', 'synced');
      return result ?? { signedOut: true };
    },

    /**
     * Back everything up now, then check for anything newer in the cloud.
     *
     * Phase 1 uploads; phase 2 polls. In that order because a user who taps
     * this has just written something and wants it safe — polling first would
     * spend the network on checking before saving.
     */
    async syncNow() {
      const provider = await getActiveProvider();
      if (provider) {
        let freshCreds = null;
        try { freshCreds = await provider.refreshCreds(storage); } catch { freshCreds = null; }

        if (freshCreds) {
          const books = await authno.library.list();
          for (const book of books) {
            if ((await storage.get(`noBackup:${book.id}`)) === 'true') continue;
            await queue.enqueue(book, provider.id);
          }
          await updateTileStatus();

          await queue.process(async (entry) => {
            const base64 = await encodeBook(entry.sessionId);
            const result = await provider.upload(entry, freshCreds, base64);
            if (result?.ok) await recordUpload(storage, entry.sessionId);
            return result;
          }, handleConflict);

          await updateTileStatus();
        }
      }
      await pollNow(syncCtx);
      return { ok: true };
    },

    async resolveConflict({ sessionId, resolution }) {
      const provider = await getActiveProvider();
      if (!provider) throw new Error('Nothing is connected.');

      if (resolution === 'keep-local') {
        const ctx = (await storage.getJSON('conflictContext', {})) ?? {};
        await queue.enqueue(
          { id: sessionId, title: ctx.title ?? 'Untitled', filePath: ctx.filePath ?? null },
          provider.id,
        );
        return { ok: true };
      }

      if (resolution === 'keep-local-no-upload') {
        // Keep this device's copy and leave the stored one alone. Dropping the
        // entry is the whole action — the conflict was the queue being stuck.
        await queue.removeSession(sessionId);
        return { ok: true };
      }

      if (resolution === 'use-cloud') {
        const creds = await provider.refreshCreds(storage);
        if (!creds) throw new Error('Nothing is connected.');
        const { base64 } = await provider.download(sessionId, creds);
        await handleImport(base64);
        await recordUpload(storage, sessionId);
        return { ok: true };
      }

      throw new Error(`Unknown resolution: ${resolution}`);
    },

    async listCloudFiles() {
      const provider = await getActiveProvider();
      if (!provider) throw new Error('Nothing is connected.');
      const creds = await provider.refreshCreds(storage);
      if (!creds) throw new Error('Nothing is connected.');
      return provider.listFiles(creds);
    },

    async restoreFromCloud({ sessionId }) {
      const provider = await getActiveProvider();
      if (!provider) throw new Error('Nothing is connected.');
      const creds = await provider.refreshCreds(storage);
      if (!creds) throw new Error('Nothing is connected.');
      const { base64 } = await provider.download(sessionId, creds);
      await handleImport(base64);
      return { ok: true };
    },

    /**
     * The bytes of one stored copy.
     *
     * Exists so a page never handles credentials. v1's pages read
     * `creds:<provider>` straight out of storage, JSON.parsed it, and called
     * `provider.download(id, creds)` themselves — so an access token lived in
     * the settings frame, the conflict frame and the file picker as well as
     * here. In v2 each of those is a separate frame with its own opaque
     * origin, and the credentials stay in this one.
     */
    async downloadCloudFile({ sessionId }) {
      const provider = await getActiveProvider();
      if (!provider) throw new Error('Nothing is connected.');
      const creds = await provider.refreshCreds(storage);
      if (!creds) throw new Error('Nothing is connected.');
      return provider.download(sessionId, creds);
    },

    /** Put one book in the cloud folder as a .txt/.html/.epub/.pdf file. */
    async exportToCloud({ sessionId, format }) {
      const provider = await getActiveProvider();
      if (!provider) throw new Error('Nothing is connected.');
      const creds = await provider.refreshCreds(storage);
      if (!creds) throw new Error('Nothing is connected.');

      const exported = await authno.library.exportAs(sessionId, format);
      const base64 = typeof exported === 'string' ? exported : exported?.base64;
      if (!base64) throw new Error('That book could not be turned into a file.');

      const book = await authno.library.getAny(sessionId).catch(() => null);
      const filename = exported?.filename
        ?? `${(book?.title || 'book').replace(/[/\\:*?"<>|]/g, '')}.${format}`;

      await provider.uploadRaw(filename, base64, creds);
      return { filename, provider: provider.name };
    },

    async isBookBackupDisabled({ sessionId }) {
      return (await storage.get(`noBackup:${sessionId}`)) === 'true';
    },

    async setBookBackupDisabled({ sessionId, disabled }) {
      await storage.set(`noBackup:${sessionId}`, disabled ? 'true' : null);
      return { ok: true };
    },
  };

  // ── Serving the settings pages ────────────────────────────────────────────
  //
  // Polling rather than an event, because there is no event to have: the two
  // frames share storage and nothing else. 400ms is under the threshold where
  // a button feels unresponsive and far above the rate at which a person taps.

  let lastRequestId = null;
  const requestTimer = setInterval(async () => {
    let req;
    try { req = await storage.getJSON(REQUEST_KEY, null); } catch { return; }
    if (!req || req.id === lastRequestId) return;
    lastRequestId = req.id;

    const op = Object.prototype.hasOwnProperty.call(OPERATIONS, req.name)
      ? OPERATIONS[req.name]
      : null;

    if (typeof op !== 'function') {
      // hasOwnProperty, not `OPERATIONS[req.name]`: a page asking for
      // "constructor" would otherwise get one from Object.prototype and have
      // it called. The pages are ours, but the check costs one line.
      await storage.setJSON(RESPONSE_KEY, { id: req.id, error: `Unknown operation: ${req.name}` });
      return;
    }

    try {
      const result = await op(req.args ?? {});
      await storage.setJSON(RESPONSE_KEY, { id: req.id, result });
    } catch (e) {
      await storage.setJSON(RESPONSE_KEY, { id: req.id, error: String(e?.message ?? e) });
    }
  }, REQUEST_POLL_MS);

  // ── The commands the manifest declares ────────────────────────────────────

  // Each is named in the manifest's `commands` array; the host refuses any
  // name that is not. So what the "Back up now" button can trigger is
  // knowable by reading the manifest, before installing anything.
  //
  // `sync.status` is a readout — the settings page polls it — so it returns
  // the status rather than acting on it.
  const COMMANDS = {
    'sync.now': () => OPERATIONS.syncNow(),
    'auth.connect': () => authno.ui.navigate('settings'),
    'auth.disconnect': () => OPERATIONS.disconnectProvider(),
    'sync.status': () => OPERATIONS.getStatus(),
  };

  // The promises, not the results. `activate()` returns its deactivate
  // function synchronously while these four round trips are still in flight,
  // so a deactivate that lands first — disabling an extension straight after
  // enabling it, or the update path, which stops the old copy before
  // rewriting its files — found an empty array and unregistered nothing. The
  // handlers stayed attached to commands whose extension had gone.
  const commandRegistrations = Object.entries(COMMANDS).map(([name, fn]) =>
    authno.commands.register(name, (args) => fn(args ?? {}))
      .catch((e) => {
        console.error(`[cloud-backup] could not register ${name}:`, e.message);
        return null;
      }));

  return async function deactivate() {
    // Order matters. Stop producing work first, then stop serving requests,
    // then unhook — a hook that fires while the queue is mid-flush would
    // enqueue into a queue nobody is going to process.
    stopPolling();
    clearInterval(requestTimer);
    unregChange();
    unregAutosave();
    for (const off of await Promise.all(commandRegistrations)) {
      if (typeof off === 'function') { try { off(); } catch { /* going regardless */ } }
    }
  };
}
