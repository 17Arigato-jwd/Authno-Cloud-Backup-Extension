/**
 * providers/base.js — v1.2.0
 *
 * Changes from v1.1.0:
 *   - Added _refreshIfNeeded(creds) base implementation (returns creds unchanged)
 *     so subclasses that don't override it still work in refreshCreds().
 *   - Added refreshCreds(storage): loads creds, refreshes if expired, saves back.
 *     Call this instead of loadCreds() before any upload or download so tokens
 *     are always persisted after a refresh. Fixes the silent token-discard bug
 *     where _refreshIfNeeded() returned a new token that was never saved.
 */

export class BaseProvider {
  constructor(id) { this.id = id; }

  get name() { throw new Error('not implemented'); }
  get icon() { return 'Cloud'; }

  async connect(_config)           { throw new Error('not implemented'); }
  async disconnect(_storage)       { throw new Error('not implemented'); }
  async upload(_entry, _creds, _b) { throw new Error('not implemented'); }
  async download(_path, _creds)    { throw new Error('not implemented'); }
  async isConnected(_creds)        { return false; }

  /** Override in subclasses that use expiring tokens. */
  async _refreshIfNeeded(creds) { return creds; }

  /**
   * Load credentials, refresh if expired, persist back if changed, return fresh creds.
   * Use this instead of loadCreds() before any API call.
   * Returns null if no credentials are stored.
   */
  async refreshCreds(storage) {
    const raw = await this.loadCreds(storage);
    if (!raw) return null;
    const fresh = await this._refreshIfNeeded(raw);
    if (fresh !== raw) await this.saveCreds(storage, fresh);
    return fresh;
  }

  credsKey() { return `creds:${this.id}`; }

  async loadCreds(storage) {
    const raw = await storage.get(this.credsKey());
    return raw ? JSON.parse(raw) : null;
  }

  async saveCreds(storage, creds) {
    await storage.set(this.credsKey(), JSON.stringify(creds));
  }

  async clearCreds(storage) {
    await storage.set(this.credsKey(), null);
  }
}
