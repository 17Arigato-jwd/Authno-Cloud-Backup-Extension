/**
 * webdav.js — any WebDAV server — v2.0.0
 *
 * This is the provider that v2\'s permission model could not express, and the
 * one that shaped `network.requestHost`.
 *
 * Google Drive and Dropbox live at origins this extension can name in its
 * manifest, so the frame\'s Content-Security-Policy lists them and every fetch
 * to them simply works. A WebDAV server is whichever one the person typed in.
 * There is no host to declare, and the two ways out of that are both wrong:
 * `connect-src *` for one provider gives every provider the internet, and
 * refusing to support it removes the only option for someone who does not want
 * their manuscripts on a company\'s servers.
 *
 * So the extension asks at the moment the URL exists, the user answers, and
 * the origin joins the policy. Two consequences to know:
 *
 *   1. **A grant does not reach a running frame.** A document cannot be
 *      re-policied after it loads. `requestHost` resolves with
 *      `needsRestart: true`, and the app restarts the extension so the grant
 *      takes effect — but any fetch already in flight is still under the old
 *      policy and will fail. `connect()` therefore asks BEFORE it probes.
 *
 *   2. **The limit is real.** The manifest allows two user hosts. An extension
 *      that could accumulate origins would, and a policy naming forty of them
 *      is a policy in name only.
 *
 * Config shape (this provider\'s credentials ARE its config):
 *   {
 *     baseUrl:  "https://cloud.example.com/remote.php/dav/files/user/AuthNo/",
 *     authType: "basic" | "token",
 *     username, password,   // basic
 *     token,                // bearer
 *   }
 *
 * Remote path: <baseUrl><sessionId>.authbook
 * WebDAV methods used: PUT, GET, HEAD, PROPFIND
 */

import { BaseProvider } from './base.js';
import { arrayBufferToBase64 } from './oauth.js';

/** The origin of a URL, which is the unit a CSP grant is made in. */
function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

export class WebDAVProvider extends BaseProvider {
  constructor() { super('webdav'); }
  get name() { return 'WebDAV'; }
  get icon() { return 'Server'; }

  async connect(config) {
    const origin = originOf(config?.baseUrl);
    if (!origin) throw new Error('That does not look like a web address.');
    if (!origin.startsWith('https://')) {
      // Refused here rather than by the policy, so the reason is a sentence
      // rather than a failed request. Credentials go in the first header of
      // the first call; over http they go in clear text.
      throw new Error('A WebDAV address has to start with https:// — your username and password travel with every request.');
    }

    // Ask BEFORE probing. The probe below is a fetch, and a fetch to an origin
    // that is not yet in this frame's policy is refused by the browser — so
    // probing first would fail every time and report it as a bad server.
    const grant = await this._authno.network.requestHost(origin);
    if (!grant?.ok) throw new Error(this._grantRefusal(grant));

    if (grant.needsRestart) {
      // The policy in this document cannot change; the app restarts the
      // extension so the next one has the origin. Saying so is the whole
      // point — a silent failure here looks like a server that is down.
      return { ...config, _pendingRestart: true };
    }

    const res = await fetch(config.baseUrl, {
      method: 'PROPFIND',
      headers: { ...this._authHeaders(config), Depth: '0' },
    });
    if (!res.ok && res.status !== 207) {
      throw new Error(`Your server answered ${res.status}. Check the address and your sign-in details.`);
    }
    return config;   // for WebDAV the config IS the credentials
  }

  /** Why a host grant did not happen, in words a person can act on. */
  _grantRefusal(grant) {
    switch (grant?.reason) {
      case 'declined':
        return 'You did not allow a connection to that server.';
      case 'too-many-hosts':
        return 'This extension is already allowed as many servers as it can have. Disconnect one first.';
      case 'no-network-permission':
        return 'This extension has not been allowed to connect to the internet.';
      case 'bad-host':
        return `That address cannot be used: ${grant.detail ?? 'it is not a plain https origin'}.`;
      default:
        return 'That server could not be allowed.';
    }
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

    const buf = await res.arrayBuffer();
    // RC-5 FIX: chunked conversion — safe for large .authbook files.
    // Old code: btoa(String.fromCharCode(...new Uint8Array(buf))) → stack overflow above ~50 MB
    const base64 = arrayBufferToBase64(buf);
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
