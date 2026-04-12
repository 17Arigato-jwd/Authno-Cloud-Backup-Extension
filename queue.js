/**
 * queue.js — v1.2.0
 *
 * Changes from v1.1.0:
 *   - process() now stamps lastUploadedAt on successful entries before removing
 *     them. Conflict detection in providers compares remoteTime > lastUploadedAt,
 *     so without this every upload after the first triggered a false conflict.
 *   - process() now removes permanently-failed entries (attempts >= MAX_TRIES)
 *     from the queue on each dirty save so they don't accumulate forever.
 *   - statusSummary() unchanged.
 */

const QUEUE_KEY  = 'uploadQueue';
const MAX_TRIES  = 5;
const BACKOFF_MS = [0, 30_000, 120_000, 600_000, 1_800_000];

export class UploadQueue {
  constructor(storage) {
    this._storage = storage;
    this._running = false;
  }

  async _load() {
    const raw = await this._storage.get(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  }

  async _save(queue) {
    await this._storage.set(QUEUE_KEY, JSON.stringify(queue));
  }

  async enqueue(session, providerKey) {
    const queue = await this._load();
    const idx   = queue.findIndex(e => e.sessionId === session.id);

    const entry = {
      sessionId:      session.id,
      title:          session.title || 'Untitled',
      filePath:       session.filePath || null,
      attempts:       0,
      nextRetry:      Date.now(),
      lastUploadedAt: null,
      providerKey,
      errorMsg:       null,
    };

    if (idx >= 0) {
      // Preserve lastUploadedAt from previous successful upload so conflict
      // detection keeps working after re-queuing a changed session.
      entry.lastUploadedAt = queue[idx].lastUploadedAt ?? null;
      queue[idx] = { ...queue[idx], ...entry };
    } else {
      queue.push(entry);
    }

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
          console.warn(`[cloud-backup] upload failed (attempt ${entry.attempts}/${MAX_TRIES}):`, err.message);
        }
      }

      if (dirty) {
        // Remove completed entries AND permanently-failed ones
        const next = queue.filter(e => !e._done && e.attempts < MAX_TRIES);
        await this._save(next);
      }
    } finally {
      this._running = false;
    }
  }

  async clear() { await this._save([]); }

  async removeSession(sessionId) {
    const queue = await this._load();
    await this._save(queue.filter(e => e.sessionId !== sessionId));
  }
}
