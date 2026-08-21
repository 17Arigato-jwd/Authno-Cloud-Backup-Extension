/**
 * test/run.mjs — the parts of this extension that can be tested on their own.
 *
 * There was no test of any kind here, which is how two bugs shipped in 2.0.0
 * that reading the code would have caught: both are contradictions between
 * what a comment in the file says and what the code beside it does.
 *
 * Plain node, no framework. Everything under test is a class given a storage
 * object and asked to do arithmetic — the provider network calls and the host
 * API are exercised by `npm run check:cloud-backup` in the app repo, which
 * runs this extension for real in a sandboxed frame.
 *
 * Usage: npm test
 */

import { UploadQueue } from '../queue.js';
import { BaseProvider } from '../base.js';

let failed = 0;
let ran = 0;
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', O = '\x1b[0m';

async function test(name, fn) {
  ran++;
  try { await fn(); process.stdout.write(`  ${G}✓${O} ${name}\n`); }
  catch (e) { failed++; process.stdout.write(`  ${R}✗${O} ${name}\n    ${R}${e.message}${O}\n`); }
}
function is(actual, expected, what) {
  const a = JSON.stringify(actual); const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what ?? 'value'}: expected ${b}, got ${a}`);
}
function group(name) { process.stdout.write(`\n${name}\n`); }

/** A storage that behaves like the host's: getJSON falls back, setJSON persists. */
function memStorage() {
  const store = new Map();
  return {
    _store: store,
    getJSON: async (k, d) => { try { return store.has(k) ? JSON.parse(store.get(k)) : d; } catch { return d; } },
    setJSON: async (k, v) => { store.set(k, JSON.stringify(v)); },
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => { v === null ? store.delete(k) : store.set(k, v); },
    remove: async (k) => { store.delete(k); },
  };
}

/** Run the queue once with every retry due, so backoff does not hide anything. */
async function processNow(q, uploadFn, onConflict) {
  const all = await q.all();
  for (const e of all) e.nextRetry = 0;
  await q._save(all);
  await q.process(uploadFn, onConflict);
}

const BOOK = (id) => ({ id, title: `Book ${id}`, filePath: `/${id}.authbook` });

// The queue logs every failed attempt on purpose. Here it buries the results.
const realError = console.error;
const quiet = async (fn) => { console.error = () => {}; try { return await fn(); } finally { console.error = realError; } };
const FAIL = async () => { throw new Error('network down'); };
const OK = async () => ({ ok: true });

// ── The queue ───────────────────────────────────────────────────────────────
//
// A permanently-failed entry used to be deleted along with the completed ones.
// Three things in this file are written assuming it is not, and all three were
// dead because of it.

group('the upload queue');

await test('drops an entry that uploaded', async () => {
  const q = new UploadQueue(memStorage());
  await q.enqueue(BOOK('a'), 'gdrive');
  await processNow(q, OK);
  is((await q.all()).length, 0, 'queue length');
});

await test('keeps an entry that ran out of attempts', async () => {
  const q = new UploadQueue(memStorage());
  await q.enqueue(BOOK('a'), 'gdrive');
  await quiet(async () => { for (let i = 0; i < 5; i++) await processNow(q, FAIL); });
  const all = await q.all();
  is(all.length, 1, 'queue length');
  is(all[0].attempts, 5, 'attempts');
});

await test('reports an error rather than "synced" when a book has failed', async () => {
  // The home-screen tile and the settings readout both read this. Answering
  // "synced" for a book that failed five times is a backup tool telling
  // somebody their work is safe when it is not.
  const q = new UploadQueue(memStorage());
  await q.enqueue(BOOK('a'), 'gdrive');
  await quiet(async () => { for (let i = 0; i < 5; i++) await processNow(q, FAIL); });
  is(await q.statusSummary(), 'error', 'status');
});

await test('gives a failed book a fresh attempt on the next start', async () => {
  const q = new UploadQueue(memStorage());
  await q.enqueue(BOOK('a'), 'gdrive');
  await quiet(async () => { for (let i = 0; i < 5; i++) await processNow(q, FAIL); });
  is(await q.resetFailed(), true, 'resetFailed found something');
  is((await q.all())[0].attempts, 0, 'attempts after reset');
  await processNow(q, OK);
  is((await q.all()).length, 0, 'uploaded on the retry');
});

await test('keeps a conflict on record after the dialog is dismissed', async () => {
  const q = new UploadQueue(memStorage());
  await q.enqueue(BOOK('a'), 'gdrive');
  let asked = null;
  await processNow(q, async () => ({ conflict: true, cloudModified: 'x' }), (e) => { asked = e.sessionId; });
  is(asked, 'a', 'onConflict called');
  is((await q.all()).length, 1, 'the entry survives');
  is(await q.statusSummary(), 'error', 'status');
});

await test('a skipped session is not a failure', async () => {
  const q = new UploadQueue(memStorage());
  await q.enqueue(BOOK('a'), 'gdrive');
  await processNow(q, async () => ({ skip: true }));
  is((await q.all())[0].attempts, 0, 'attempts');
});

await test('a book edited after it uploaded is not a conflict against itself', async () => {
  // The baseline the providers compare the cloud's modified time against. With
  // none, every upload after the first sees a remote file newer than zero and
  // raises a conflict — against the copy this extension put there.
  const storage = memStorage();
  const uploads = new Map();
  const q = new UploadQueue(storage, async (id) => uploads.get(id) ?? null);

  await q.enqueue(BOOK('a'), 'gdrive');
  await processNow(q, async (entry) => {
    uploads.set(entry.sessionId, new Date().toISOString());   // what recordUpload does
    return { ok: true };
  });
  is((await q.all()).length, 0, 'uploaded and left the queue');

  await q.enqueue(BOOK('a'), 'gdrive');   // the writer edits it again
  const [entry] = await q.all();
  if (!entry.lastUploadedAt) {
    throw new Error('no baseline, so the next upload compares against zero and conflicts with itself');
  }
});

await test('carries the baseline forward while the entry is still queued', async () => {
  const q = new UploadQueue(memStorage());
  await q.enqueue(BOOK('a'), 'gdrive');
  const all = await q.all();
  all[0].lastUploadedAt = '2026-01-01T00:00:00.000Z';
  await q._save(all);
  await q.enqueue(BOOK('a'), 'gdrive');
  is((await q.all())[0].lastUploadedAt, '2026-01-01T00:00:00.000Z', 'baseline');
});

await test('has no baseline for a book that has never uploaded', async () => {
  const q = new UploadQueue(memStorage(), async () => null);
  await q.enqueue(BOOK('new'), 'gdrive');
  is((await q.all())[0].lastUploadedAt, null, 'baseline');
});

// ── Provider credentials ────────────────────────────────────────────────────

group('renewing a token part way through a long operation');

let renewals = 0;
class Rotating extends BaseProvider {
  get name() { return 'Rotating'; }
  // Dropbox retires the refresh token it was given, every time.
  async _refreshIfNeeded(creds) {
    if (Date.now() < creds.expiresAt - 60_000) return creds;
    renewals++;
    if (creds.refreshToken !== `rt${renewals - 1}`) {
      throw new Error(`presented a refresh token the provider had already retired (${creds.refreshToken})`);
    }
    return { ...creds, accessToken: `at${renewals}`, refreshToken: `rt${renewals}`, expiresAt: Date.now() + 3600_000 };
  }
}

await test('writes the renewed credentials down', async () => {
  renewals = 0;
  const storage = memStorage();
  const p = new Rotating('rot').bind({}, storage);
  await p.saveCreds(storage, { accessToken: 'at0', refreshToken: 'rt0', expiresAt: 0 });

  let creds = await p.loadCreds(storage);
  for (let i = 0; i < 5; i++) {
    creds = await p.freshen(creds);
    creds = { ...creds, expiresAt: 0 };   // expires again, mid-operation
  }
  is((await p.loadCreds(storage)).refreshToken, 'rt5', 'refresh token on disk');
});

await test('refreshCreds still persists, as it always did', async () => {
  renewals = 0;
  const storage = memStorage();
  const p = new Rotating('rot').bind({}, storage);
  await p.saveCreds(storage, { accessToken: 'at0', refreshToken: 'rt0', expiresAt: 0 });
  await p.refreshCreds(storage);
  is((await p.loadCreds(storage)).refreshToken, 'rt1', 'refresh token on disk');
});

await test('does nothing when the token is still good', async () => {
  renewals = 0;
  const storage = memStorage();
  const p = new Rotating('rot').bind({}, storage);
  const creds = { accessToken: 'at0', refreshToken: 'rt0', expiresAt: Date.now() + 3600_000 };
  await p.saveCreds(storage, creds);
  await p.freshen(creds);
  is(renewals, 0, 'renewals');
});

await test('has nothing to renew when nobody has connected', async () => {
  const storage = memStorage();
  const p = new Rotating('rot').bind({}, storage);
  is(await p.refreshCreds(storage), null, 'refreshCreds with no credentials');
});

process.stdout.write(`\n${failed ? R : G}${ran - failed}/${ran} passed${O}\n`);
process.exit(failed ? 1 : 0);
