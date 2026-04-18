/**
 * providers/webdav.js — WebDAV provider
 *
 * Supports any WebDAV-compatible server: Nextcloud, ownCloud, Seafile,
 * and generic self-hosted servers via basic auth or bearer token.
 *
 * Config shape (stored via extension storage):
 *   {
 *     baseUrl:    "https://cloud.example.com/remote.php/dav/files/user/AuthNo/",
 *     authType:   "basic" | "token",
 *     username:   "...",     // basic auth only
 *     password:   "...",     // basic auth only  — TODO: move to Android Keystore
 *     token:      "...",     // bearer token only — TODO: move to Android Keystore
 *   }
 *
 * Remote path: <baseUrl><sessionId>.authbook
 *
 * WebDAV methods used: PUT, GET, HEAD, PROPFIND
 */

import { BaseProvider } from './base.js';

export class WebDAVProvider extends BaseProvider {
  constructor() { super('webdav'); }
  get name() { return 'WebDAV'; }
  get icon() { return 'Server'; }

  async connect(config) {
    // Validate config by doing a PROPFIND on the base URL
    const headers = this._authHeaders(config);
    const res = await fetch(config.baseUrl, {
      method: 'PROPFIND',
      headers: { ...headers, Depth: '0' },
    });
    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV connection failed (${res.status}). Check your URL and credentials.`);
    }
    // Config IS the credentials for WebDAV
    return config;
  }

  async disconnect(storage) {
    await this.clearCreds(storage);
  }

  async isConnected(creds) {
    if (!creds?.baseUrl) return false;
    try {
      const res = await fetch(creds.baseUrl, {
        method: 'PROPFIND',
        headers: { ...this._authHeaders(creds), Depth: '0' },
      });
      return res.ok || res.status === 207;
    } catch { return false; }
  }

  async upload(entry, creds, base64) {
    const url    = this._urlForSession(creds, entry.sessionId);
    const bytes  = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const headers = this._authHeaders(creds);

    // Conflict check via HEAD
    const headRes = await fetch(url, { method: 'HEAD', headers });
    if (headRes.ok) {
      const remoteLastMod  = headRes.headers.get('Last-Modified');
      const lastUploaded   = entry.lastUploadedAt;
      if (remoteLastMod && lastUploaded) {
        const remoteTime = new Date(remoteLastMod).getTime();
        const ourTime    = new Date(lastUploaded).getTime();
        if (remoteTime > ourTime + 5000) {
          return { ok: false, conflict: true, cloudModified: remoteLastMod };
        }
      }
    }

    // PUT upload
    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });

    if (!putRes.ok) throw new Error(`WebDAV PUT failed: ${putRes.status}`);
    return { ok: true };
  }

  async getFileMeta(sessionId, creds) {
    const url = this._urlForSession(creds, sessionId);
    const res = await fetch(url, { method: 'HEAD', headers: this._authHeaders(creds) });
    if (!res.ok) return null;
    return { modifiedTime: res.headers.get('Last-Modified') ?? new Date().toISOString() };
  }

  async listFiles(creds) {
    const base = creds.baseUrl.endsWith('/') ? creds.baseUrl : creds.baseUrl + '/';
    const res = await fetch(base, {
      method: 'PROPFIND',
      headers: { ...this._authHeaders(creds), Depth: '1',
        'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>',
    });
    if (!res.ok && res.status !== 207) throw new Error(`WebDAV PROPFIND failed: ${res.status}`);
    const text = await res.text();
    const matches = [...text.matchAll(/<d:href>([^<]+\.authbook)<\/d:href>[\s\S]*?<d:getlastmodified>([^<]*)<\/d:getlastmodified>[\s\S]*?<d:getcontentlength>([^<]*)<\/d:getcontentlength>/g)];
    return matches.map(m => {
      const name = m[1].split('/').pop();
      return {
        name,
        sessionId: name.replace(/^authno_/, '').replace(/\.authbook$/, ''),
        modifiedTime: m[2],
        size: parseInt(m[3] || '0', 10),
      };
    });
  }

  async uploadRaw(filename, base64, creds) {
    const base  = creds.baseUrl.endsWith('/') ? creds.baseUrl : creds.baseUrl + '/';
    const url   = `${base}${filename}`;
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const res   = await fetch(url, {
      method: 'PUT',
      headers: { ...this._authHeaders(creds), 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!res.ok) throw new Error(`WebDAV PUT failed: ${res.status}`);
    return { ok: true };
  }

  async download(sessionId, creds) {
    const url = this._urlForSession(creds, sessionId);
    const res = await fetch(url, {
      method: 'GET',
      headers: this._authHeaders(creds),
    });
    if (!res.ok) throw new Error(`WebDAV GET failed: ${res.status}`);

    const buf    = await res.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return { base64, modifiedAt: res.headers.get('Last-Modified') ?? new Date().toISOString() };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _urlForSession(creds, sessionId) {
    const base = creds.baseUrl.endsWith('/') ? creds.baseUrl : creds.baseUrl + '/';
    return `${base}${sessionId}.authbook`;
  }

  _authHeaders(creds) {
    if (creds.authType === 'token') {
      return { Authorization: `Bearer ${creds.token}` };
    }
    // Basic auth
    const encoded = btoa(`${creds.username}:${creds.password}`);
    return { Authorization: `Basic ${encoded}` };
  }
}
