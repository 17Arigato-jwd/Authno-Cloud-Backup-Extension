/**
 * queue.js — the upload queue — v2.0.0
 *
 * This module never touched the host in v1 and does not now: it is given a
 * `storage` and does arithmetic on a list. That is why it ports unchanged in
 * substance, and it is worth saying out loud — the parts of an extension that
 * do not reach for globals are the parts a platform change cannot break.
 *
 * The two behaviours worth keeping in mind when reading it:
 *
 *   - **`{ skip: true }` is not a failure.** A session that is not available
 *     in this autosave cycle must be left at attempts=0. Returning
 *     `{ ok: false, error }` for it — which is what v1 did before RC-3 — put
 *     every unrelated entry in the queue into exponential backoff.
 *
 *   - **A conflict ends the entry.** attempts is set to MAX_TRIES so it stops
 *     being retried, and the user is asked. Retrying a conflict just produces
 *     the same conflict.
 */

const QUEUE_KEY  = 'uploadQueue';
const MAX_TRIES  = 5;
const BACKOFF_MS = [0, 30_000, 120_000, 600_000, 1_800_000];

export class UploadQueue {
  /**
   * @param storage
   * @param {(sessionId: string) => Promise<string|null>} [baselineFor]
   *   When this book last uploaded, from somewhere that outlives a queue
   *   entry. Optional so this class stays testable on its own; without it the
   *   queue behaves as it did, which is the bug described on `enqueue`.
   */
  constructor(storage, baselineFor = null) {
    this._storage = storage;
    this._baselineFor = baselineFor;
    this._running = false;
  }

  async _load() {
    // getJSON rather than get + JSON.parse: the host's version returns the
    // fallback for a corrupt value instead of undefined, so a damaged queue
    // reads as an empty one rather than crashing every caller downstream.
    return (await this._storage.getJSON(QUEUE_KEY, [])) ?? [];
  }

  async _save(queue) {
    await this._storage.setJSON(QUEUE_KEY, queue);
  }

  /**
   * Put a book in the queue, carrying forward when it last uploaded.
   *
   * That baseline is what the providers compare the cloud's modified time
   * against: a remote file newer than our last upload means somebody else
   * changed it, and the user has to choose. With no baseline the comparison is
   * against zero, so ANY existing remote file reads as a conflict.
   *
   * The old code took it from the entry already in the queue, and there is
   * never one: a successful upload marks the entry `_done` and `process()`
   * removes it. So the second upload of a book — every edit after the first
   * one — compared against zero and raised a conflict against our own previous
   * upload. The dialog offers "use the cloud version", which would have
   * replaced newer local writing with the copy we ourselves made.
   *
   * `recordUpload()` in sync.js has always written a durable per-session
   * baseline, and the poll has always read it. This reads the same one, so the
   * two halves finally agree about when a book last went up.
   */
  async enqueue(session, providerKey) {
    const queue = await this._load();
    const idx   = queue.findIndex(e => e.sessionId === session.id);

    const carried = idx >= 0
      ? queue[idx].lastUploadedAt ?? null
      : (this._baselineFor ? await this._baselineFor(session.id) : null);

    const entry = {
      sessionId:      session.id,
      title:          session.title || 'Untitled',
      filePath:       session.filePath || null,
      attempts:       0,
      nextRetry:      Date.now(),
      lastUploadedAt: carried,
      providerKey,
      errorMsg:       null,
    };

    if (idx >= 0) queue[idx] = { ...queue[idx], ...entry };
    else queue.push(entry);

    await this._save(queue);
  }

  async all() { return this._load(); }

  async statusSummary() {
    const queue = await this._load();
    if (queue.length === 0) return 'synced';
    const hasError   = queue.some(e => e.attempts >= MAX_TRIES);
    const hasPending = queue.some(e => e.attempts < MAX_TRIES);
    if (hasError && !hasPending) return 'error';
    return 'syncing';
  }

  async process(uploadFn, onConflict) {
    if (this._running) return;
    this._running = true;

    try {
      const queue = await this._load();
      const now   = Date.now();
      let dirty   = false;

      for (const entry of queue) {
        if (entry.attempts >= MAX_TRIES) continue;
        if (entry.nextRetry > now) continue;

        try {
          const result = await uploadFn(entry);

          if (result?.conflict) {
            onConflict?.(entry, result.cloudModified);
            entry.attempts = MAX_TRIES;
            dirty = true;
            continue;
          }

          // ── FIX (RC-3): skip sentinel ────────────────────────────────────
          // uploadFn returns { skip: true } when this session isn't available
          // in the current autosave cycle. Do NOT increment attempts — leave
          // the entry exactly as-is so it is tried normally next cycle.
          if (result?.skip) {
            continue;
          }
          // ─────────────────────────────────────────────────────────────────

          if (result?.ok) {
            // Stamp the upload time so next conflict check has a baseline
            entry.lastUploadedAt = new Date().toISOString();
            entry._done = true;
            dirty = true;
          } else {
            throw new Error(result?.error || 'Upload failed');
          }
        } catch (err) {
          entry.attempts++;
          entry.errorMsg  = err.message;
          entry.nextRetry = Date.now() + (BACKOFF_MS[entry.attempts] ?? BACKOFF_MS.at(-1));
          dirty = true;
          console.error(`[cloud-backup] UPLOAD FAILED [${entry.title}] attempt ${entry.attempts}/${MAX_TRIES}:`, err.message, err.stack ?? '');
        }
      }

      if (dirty) {
        // Only what finished. A permanently-failed entry STAYS.
        //
        // This used to drop those too, and every other behaviour in this file
        // is written on the assumption that it does not:
        //
        //   - `resetFailed()` exists to give a failed book a fresh attempt on
        //     each app start. It searches for attempts >= MAX_TRIES, and there
        //     was never anything left to find. Dead from the day it was
        //     written.
        //   - `statusSummary()` reports 'error' when something has run out of
        //     attempts. Nothing at MAX_TRIES survived to be counted, so it
        //     answered 'synced' — a backup tool telling somebody their book is
        //     safe when the upload had failed five times and been forgotten.
        //   - A conflict sets attempts = MAX_TRIES to stop the retries, and
        //     was deleted for it. The dialog fires once; dismiss it and no
        //     record of the conflict remained anywhere.
        //
        // A failed entry is not litter. It is the only evidence that a book is
        // not backed up.
        const next = queue.filter(e => !e._done);
        await this._save(next);
      }
    } finally {
      this._running = false;
    }
  }

  /**
   * Reset all permanently-failed entries (attempts >= MAX_TRIES) back to 0
   * so they get retried. Called on activate() so failed books don't stay
   * stuck forever — they get one fresh attempt on every app start.
   */
  async resetFailed() {
    const queue = await this._load();
    let changed = false;
    for (const entry of queue) {
      if (entry.attempts >= MAX_TRIES) {
        entry.attempts  = 0;
        entry.nextRetry = Date.now();
        entry.errorMsg  = null;
        changed = true;
      }
    }
    if (changed) {
      await this._save(queue);
      console.log(`[cloud-backup] resetFailed: ${queue.filter(e => !e.attempts).length} entries reset`);
    }
    return changed;
  }

  async clear() { await this._save([]); }

  async removeSession(sessionId) {
    const queue = await this._load();
    await this._save(queue.filter(e => e.sessionId !== sessionId));
  }
}
