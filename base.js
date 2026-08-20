/**
 * base.js — what every provider has in common — v2.0.0
 *
 * Unchanged from v1 apart from using the host's JSON storage helpers, because
 * nothing in here ever touched the host directly.
 *
 * `refreshCreds` is the method to call before any request. `loadCreds` alone
 * loses a refreshed token: `_refreshIfNeeded` returns a new object and only
 * `refreshCreds` writes it back, so a caller that skips it re-refreshes on
 * every single request and — with providers that rotate refresh tokens —
 * eventually presents one the provider has already retired.
 */

export class BaseProvider {
  constructor(id) { this.id = id; this._authno = null; }

  /**
   * Hand this provider the host API, once, at activate().
   *
   * Instance state rather than a module-level variable, and that distinction
   * is the whole v2 story in miniature: v1 reached for
   * `window.CloudBackupAPI` from wherever it happened to need it, so any code
   * in the frame could use any capability and nothing recorded who asked. A
   * provider that is *given* the host can only use what it was given, and the
   * giving happens in one line in index.js that is easy to read.
   *
   * It is on the instance rather than threaded through every method because
   * `_refreshIfNeeded` is called from five places inside each provider, and a
   * token that expires halfway through a sixty-book poll has to renew without
   * every call site having remembered to pass a context down.
   */
  bind(authno) { this._authno = authno; return this; }

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

  credsKey() { return `creds:${this.id}`; }

  async loadCreds(storage) {
    return (await storage.getJSON(this.credsKey(), null)) ?? null;
  }

  async saveCreds(storage, creds) {
    await storage.setJSON(this.credsKey(), creds);
  }

  async clearCreds(storage) {
    await storage.remove(this.credsKey());
  }

  async refreshCreds(storage) {
    const raw = await this.loadCreds(storage);
    if (!raw) return null;
    const fresh = await this._refreshIfNeeded(raw);
    // If the token was updated, save it back to storage immediately
    if (fresh !== raw) await this.saveCreds(storage, fresh);
    return fresh;
  }
}
