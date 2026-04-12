/**
 * queue.js — upload queue for cloud-backup extension
 *
 * Persists pending uploads via extension storage so they survive app restarts.
 * Each queue entry:
 *   { sessionId, filePath, base64, attempts, nextRetry, provider }
 *
 * Backoff schedule (attempts → delay before next retry):
 *   0 → immediate
 *   1 → 30 s
 *   2 → 2 min
 *   3 → 10 min
 *   4 → 30 min
 *   5+ → give up, mark as error
 */

const QUEUE_KEY   = 'uploadQueue';
const MAX_TRIES   = 5;
const BACKOFF_MS  = [0, 30_000, 120_000, 600_000, 1_800_000];

export class UploadQueue {
  constructor(storage) {
    this._storage = storage;
    this._running = false;
  }

  // ── Read / write ────────────────────────────────────────────────────────────

  async _load() {
    const raw = await this._storage.get(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  }

  async _save(queue) {
    await this._storage.set(QUEUE_KEY, JSON.stringify(queue));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Enqueue or refresh a session for upload.
   * If the session is already queued, resets attempts so the new content wins.
   */
  async enqueue(session, providerKey) {
    const queue = await this._load();
    const idx   = queue.findIndex(e => e.sessionId === session.id);

    const entry = {
      sessionId:  session.id,
      title:      session.title || 'Untitled',
      filePath:   session.filePath || null,
      attempts:   0,
      nextRetry:  Date.now(),
      providerKey,
      errorMsg:   null,
    };

    if (idx >= 0) {
      queue[idx] = { ...queue[idx], ...entry };
    } else {
      queue.push(entry);
    }

    await this._save(queue);
  }

  /** Return all entries */
  async all() {
    return this._load();
  }

  /** Return a summary { synced, syncing, error } for the homescreen tile */
  async statusSummary() {
    const queue = await this._load();
    if (queue.length === 0) return 'synced';
    const hasError   = queue.some(e => e.attempts >= MAX_TRIES);
    const hasPending = queue.some(e => e.attempts < MAX_TRIES);
    if (hasError && !hasPending) return 'error';
    return 'syncing';
  }

  /**
   * Process the queue. Calls uploadFn(entry) → { ok, conflict, cloudModified }.
   * Should be called after every autosave hook fires.
   *
   * @param {function} uploadFn
   * @param {function} onConflict — called with the conflicting entry
   */
  async process(uploadFn, onConflict) {
    if (this._running) return;
    this._running = true;

    try {
      const queue = await this._load();
      const now   = Date.now();
      let dirty   = false;

      for (const entry of queue) {
        if (entry.attempts >= MAX_TRIES) continue;  // already failed permanently
        if (entry.nextRetry > now) continue;         // backoff not yet elapsed

        try {
          const result = await uploadFn(entry);

          if (result?.conflict) {
            // Cloud version is newer — hand off to conflict resolution
            onConflict?.(entry, result.cloudModified);
            // Remove from queue; conflict UI takes over
            entry.attempts = MAX_TRIES;
            dirty = true;
            continue;
          }

          if (result?.ok) {
            // Success — remove from queue
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
        const next = queue.filter(e => !e._done && e.attempts < MAX_TRIES);
        await this._save(next);
      }
    } finally {
      this._running = false;
    }
  }

  /** Clear the entire queue (e.g. when user disconnects a provider) */
  async clear() {
    await this._save([]);
  }

  /** Remove entries for a specific session */
  async removeSession(sessionId) {
    const queue = await this._load();
    await this._save(queue.filter(e => e.sessionId !== sessionId));
  }
}
