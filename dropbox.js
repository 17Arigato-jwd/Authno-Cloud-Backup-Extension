/**
 * dropbox.js — the Dropbox provider — v2.0.0
 *
 * Renamed from dropbox_onedrive.js: OneDrive was removed in v1.3.0 and the
 * filename outlived it by four releases.
 *
 * What left this file for v2:
 *
 *   - ~90 lines of hand-rolled PKCE, now `pkceOAuthFlow` in oauth.js, which is
 *     four lines around one host call. See the note there — the cold-start
 *     resume, the duplicate-listener guard and the redirect matching were all
 *     this extension\'s problem in v1 and are the host\'s now.
 *   - `window.CloudBackupAPI.openBrowser`. There are no globals inside a v2
 *     frame; the host arrives as an argument.
 *
 * What did not change: every `fetch` below. v2 enforces the network permission
 * with the frame\'s Content-Security-Policy rather than with a bridge, so an
 * ordinary fetch to a host named in the manifest simply works, and one to a
 * host that is not named simply does not. api.dropboxapi.com and
 * content.dropboxapi.com are both listed, because Dropbox splits metadata and
 * content across two origins and missing the second would look like every
 * upload failing while every listing succeeded.
 */

import { BaseProvider } from './base.js';
import { pkceOAuthFlow, arrayBufferToBase64 } from './oauth.js';

// ── DROPBOX ───────────────────────────────────────────────────────────────────

const DROPBOX_CLIENT_ID    = '4rvmxehs92acpqw';
// RC-1 FIX (v1.4.0): :// not :/ — android:host="oauth2" requires an authority
// component (double-slash).  Also registered in the Dropbox App Console.
const DROPBOX_REDIRECT_URI = 'com.aurorastudios.authno://oauth2/dropbox';
const DROPBOX_REMOTE_ROOT  = '/AuthNo';

export class DropboxProvider extends BaseProvider {
  constructor() { super('dropbox'); }
  get name() { return 'Dropbox'; }
  get icon() { return 'Box'; }

  async connect(_config) {
    return pkceOAuthFlow(this._authno, {
      authUrl: 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
        client_id:         DROPBOX_CLIENT_ID,
        redirect_uri:      DROPBOX_REDIRECT_URI,
        response_type:     'code',
        // Without this Dropbox issues a short-lived access token and no
        // refresh token, and the extension silently stops backing up four
        // hours after the user connects it.
        token_access_type: 'offline',
      }),
      tokenUrl:    'https://api.dropboxapi.com/oauth2/token',
      clientId:    DROPBOX_CLIENT_ID,
      redirectUri: DROPBOX_REDIRECT_URI,
    });
  }

  async disconnect(storage) { await this.clearCreds(storage); }

  async _refreshIfNeeded(creds) {
    if (Date.now() < creds.expiresAt - 60_000) return creds;
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     DROPBOX_CLIENT_ID,
        grant_type:    'refresh_token',
        refresh_token: creds.refreshToken,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Dropbox token refresh failed (${res.status}): ${body}`);
    }
    const tokens = await res.json();
    return { ...creds, accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  }

  async isConnected(creds) {
    if (!creds?.accessToken) return false;
    try {
      const res = await fetch('https://api.dropboxapi.com/2/check/user', {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'ping' }),
      });
      return res.ok;
    } catch { return false; }
  }

  /** Sanitise a book title for use in a Dropbox filename. */
  _safeTitle(raw) {
    return (raw || 'Untitled')
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'Untitled';
  }

  _remotePath(sessionId, title) {
    // New format:  /AuthNo/{SafeTitle}_{sessionId}.authbook
    // title is optional — falls back to old format for downloads that only know the sessionId.
    if (title) return `${DROPBOX_REMOTE_ROOT}/${this._safeTitle(title)}_${sessionId}.authbook`;
    return `${DROPBOX_REMOTE_ROOT}/${sessionId}.authbook`;
  }

  async upload(entry, creds, base64) {
    creds = await this.freshen(creds);
    // Use readable filename: {SafeTitle}_{sessionId}.authbook
    const path   = this._remotePath(entry.sessionId, entry.title);
    const apiArg = { path, mode: 'overwrite', autorename: false };
    const bytes  = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

    console.log(`[Dropbox] UPLOAD starting — path: ${path}, size: ${bytes.length} bytes, sessionId: ${entry.sessionId}`);

    // ── Conflict check ───────────────────────────────────────────────────────
    try {
      const metaRes = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (metaRes.ok) {
        const meta         = await metaRes.json();
        const remoteTime   = new Date(meta.server_modified).getTime();
        const lastUploaded = entry.lastUploadedAt ? new Date(entry.lastUploadedAt).getTime() : 0;
        console.log(`[Dropbox] CONFLICT_CHECK — remoteTime: ${meta.server_modified}, lastUploaded: ${entry.lastUploadedAt}`);
        if (remoteTime > lastUploaded + 5000) {
          console.warn(`[Dropbox] CONFLICT detected for ${path}`);
          return { ok: false, conflict: true, cloudModified: meta.server_modified };
        }
      } else {
        const metaBody = await metaRes.text().catch(() => '');
        console.log(`[Dropbox] CONFLICT_CHECK skipped (${metaRes.status}) — file likely new. Body: ${metaBody}`);
      }
    } catch (e) { console.log(`[Dropbox] CONFLICT_CHECK threw (file likely new): ${e.message}`); }

    // ── Upload ───────────────────────────────────────────────────────────────
    const apiArgStr = JSON.stringify(apiArg);
    console.log(`[Dropbox] UPLOAD request — Dropbox-API-Arg: ${apiArgStr}`);

    const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization:     `Bearer ${creds.accessToken}`,
        'Content-Type':    'application/octet-stream',
        'Dropbox-API-Arg': apiArgStr,
      },
      body: bytes,
    });

    if (!uploadRes.ok) {
      const body = await uploadRes.text().catch(() => '<empty body>');
      const msg = [
        `[Dropbox] UPLOAD FAILED`,
        `  Operation : files/upload (auto-backup)`,
        `  Path      : ${path}`,
        `  API-Arg   : ${apiArgStr}`,
        `  Status    : ${uploadRes.status} ${uploadRes.statusText}`,
        `  Body      : ${body}`,
      ].join('\n');
      console.error(msg);
      throw new Error(`Dropbox UPLOAD failed (${uploadRes.status}) — path: ${path} — ${body}`);
    }
    console.log(`[Dropbox] UPLOAD OK — ${path}`);
    return { ok: true };
  }

  async getFileMeta(sessionId, creds) {
    creds = await this.freshen(creds);
    const path = this._remotePath(sessionId);
    try {
      const res = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '<empty body>');
        console.log(`[Dropbox] GET_METADATA (${res.status}) — path: ${path} — ${body}`);
        return null;
      }
      const meta = await res.json();
      return { modifiedTime: meta.server_modified };
    } catch (e) {
      console.log(`[Dropbox] GET_METADATA threw — path: ${path} — ${e.message}`);
      return null;
    }
  }

  async listFiles(creds) {
    creds = await this.freshen(creds);
    console.log(`[Dropbox] LIST_FOLDER — path: ${DROPBOX_REMOTE_ROOT}`);

    const res = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: DROPBOX_REMOTE_ROOT }),
    });

    // 409 = folder not found (no files uploaded yet) — treat as empty list
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      console.log(`[Dropbox] LIST_FOLDER 409 — body: ${JSON.stringify(body)}`);
      if (body?.error?.['.tag'] === 'path' && body?.error?.path?.['.tag'] === 'not_found') {
        console.log('[Dropbox] LIST_FOLDER: AuthNo folder does not exist yet (no files uploaded)');
        return [];
      }
      throw new Error(`[Dropbox] LIST_FOLDER 409 unexpected — ${JSON.stringify(body)}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '<empty body>');
      const msg = [
        `[Dropbox] LIST_FOLDER FAILED`,
        `  Operation : files/list_folder`,
        `  Path      : ${DROPBOX_REMOTE_ROOT}`,
        `  Status    : ${res.status} ${res.statusText}`,
        `  Body      : ${body}`,
      ].join('\n');
      console.error(msg);
      throw new Error(`Dropbox LIST failed (${res.status}) — folder: ${DROPBOX_REMOTE_ROOT} — ${body}`);
    }
    const { entries = [] } = await res.json();
    const filtered = entries.filter(e => e.name.endsWith('.authbook'));
    console.log(`[Dropbox] LIST_FOLDER OK — ${entries.length} entries, ${filtered.length} .authbook files`);
    const uuidishRe = /^[0-9a-f\-]{8,}$/i;
    return filtered.map(e => {
      const withoutExt   = e.name.replace(/^authno_/, '').replace(/\.authbook$/, '');
      const underscoreAt = withoutExt.lastIndexOf('_');
      const lastSegment  = underscoreAt >= 0 ? withoutExt.slice(underscoreAt + 1) : '';
      const sessionId    = (uuidishRe.test(lastSegment) && underscoreAt > 0)
        ? lastSegment : withoutExt;
      const displayName  = (uuidishRe.test(lastSegment) && underscoreAt > 0)
        ? withoutExt.slice(0, underscoreAt).replace(/_/g, ' ') : withoutExt;
      return {
        name:        e.name,
        displayName,
        sessionId,
        // Store the exact Dropbox path so download() uses the real path, not a reconstructed one.
        dropboxPath: e.path_lower ?? `${DROPBOX_REMOTE_ROOT}/${e.name}`,
        modifiedTime: e.server_modified,
        size: e.size ?? 0,
      };
    });
  }

  async download(sessionId, creds) {
    creds = await this.freshen(creds);
    // sessionId may actually be a full dropboxPath if passed from listFiles result
    const path = sessionId.startsWith('/') ? sessionId : this._remotePath(sessionId);
    console.log(`[Dropbox] DOWNLOAD starting — path: ${path}`);

    const res = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        Authorization:     `Bearer ${creds.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<empty body>');
      const msg = [
        `[Dropbox] DOWNLOAD FAILED`,
        `  Operation : files/download`,
        `  Path      : ${path}`,
        `  Status    : ${res.status} ${res.statusText}`,
        `  Body      : ${body}`,
      ].join('\n');
      console.error(msg);
      throw new Error(`Dropbox DOWNLOAD failed (${res.status}) — path: ${path} — ${body}`);
    }

    const metaHeader = res.headers.get('dropbox-api-result');
    const meta       = metaHeader ? JSON.parse(metaHeader) : {};
    const buf        = await res.arrayBuffer();
    // RC-5 FIX: chunked conversion — safe for large .authbook files
    const b64        = arrayBufferToBase64(buf);
    return { base64: b64, modifiedAt: meta.server_modified ?? new Date().toISOString() };
  }

  /**
   * Upload any file (e.g. a .txt / .html / .epub export) to /AuthNo/<filename>.
   * Used by the "Export to cloud" feature in Settings.js.
   * Unlike upload() which targets the per-session .authbook path, this lets the
   * caller choose an arbitrary filename under the AuthNo root folder.
   */
  async uploadRaw(filename, base64, creds) {
    creds = await this.freshen(creds);
    const path   = `/AuthNo/${filename}`;
    const apiArg = { path, mode: 'overwrite', autorename: false, mute: true };
    const bytes  = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    console.log(`[Dropbox] UPLOAD_RAW starting — path: ${path}, size: ${bytes.length} bytes`);
    console.log(`[Dropbox] UPLOAD_RAW Dropbox-API-Arg: ${JSON.stringify(apiArg)}`);

    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization:     `Bearer ${creds.accessToken}`,
        'Content-Type':    'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify(apiArg),
      },
      body: bytes,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<empty body>');
      const msg = [
        `[Dropbox] UPLOAD_RAW FAILED`,
        `  Operation : files/upload (export)`,
        `  Path      : ${path}`,
        `  API-Arg   : ${JSON.stringify(apiArg)}`,
        `  Status    : ${res.status} ${res.statusText}`,
        `  Body      : ${body}`,
      ].join('\n');
      console.error(msg);
      throw new Error(`Dropbox UPLOAD_RAW failed (${res.status}) — path: ${path} — ${body}`);
    }
    console.log(`[Dropbox] UPLOAD_RAW OK — ${path}`);
  }
}
