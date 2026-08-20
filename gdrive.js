/**
 * gdrive.js — the Google Drive provider — v2.0.0
 *
 * Drive authorises differently from Dropbox, and the difference is the point
 * of `auth.requestDriveToken` rather than `auth.oauth`:
 *
 * On Android, Play Services' Identity Authorization API derives the caller
 * from the package name and signing certificate. No client id, no redirect
 * URI, no browser, no client secret, and silent renewal once consented. There
 * is nothing here that an OAuth round trip could carry.
 *
 * Off Android there is nothing to derive from, so the host falls back to a
 * PKCE round trip and needs a Desktop OAuth client id. This extension does not
 * carry one, so on desktop `connect()` fails with the host\'s own explanation
 * of what to create. That is the honest state: Drive is Android-only in this
 * build, and Dropbox and WebDAV are not.
 *
 * What changed from v1 beyond the plumbing:
 *
 *   - `window.Capacitor.Plugins.GoogleDrive` is gone. There are no globals in
 *     a v2 frame; the host arrives as an argument.
 *   - `disconnect()` actually switches accounts now. v1 called
 *     `plugin.signOut()` and then `plugin.revoke()` in a try/catch with a
 *     comment calling it essential — neither method existed in
 *     GoogleDrivePlugin.java, so the catch swallowed a TypeError every time
 *     and the next connect landed on the same account. It now hands its
 *     access token to `authno.auth.signOut()`, which revokes it at Google's
 *     endpoint: that drops the app's authorisation server-side, so the next
 *     authorize() has nothing to reuse and asks again.
 */

import { BaseProvider } from './base.js';
import { arrayBufferToBase64 } from './oauth.js';

// Token validity window: renew if less than five minutes remain. On Android
// this is silent for an already-consented user, so it costs nothing to be
// early and a request that fails on an expired token costs a retry.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const GDRIVE_FOLDER_NAME = 'AuthNo';

export class GDriveProvider extends BaseProvider {
  constructor() { super('gdrive'); }
  get name() { return 'Google Drive'; }
  get icon() { return 'HardDrive'; }

  async connect(_config) {
    const authno = this._authno;
    // Native consent sheet on first use, silent afterwards. Off Android the
    // host raises its own error naming the client id it would need.
    const { accessToken } = await authno.auth.requestDriveToken();
    if (!accessToken) throw new Error('Google returned no access token.');
    return { accessToken, expiresAt: Date.now() + 3600 * 1000 };
  }

  async disconnect(storage) {
    const authno = this._authno;

    // Read the token BEFORE clearing, because revoking it is what actually
    // ends the grant. Without it Google keeps the authorisation, the next
    // connect has something to reuse, and the account picker never appears —
    // which is exactly the bug this used to have.
    const held = await this.loadCreds(storage).catch(() => null);

    // Clear our own credentials next. If the revoke fails the user must still
    // end up disconnected rather than half-connected.
    await this.clearCreds(storage);

    const out = await authno.auth.signOut({ accessToken: held?.accessToken ?? null });
    // Reported, not swallowed. v1 swallowed exactly this and told the user the
    // account had been switched when it had not.
    // `ok` means the host reached the plugin; `revoked` means Google dropped
    // the grant. Only the second one means the next connect will ask which
    // account, so it is the one reported.
    if (!out?.ok) return { signedOut: false, reason: out?.reason ?? 'unsupported' };
    return { signedOut: true, revoked: !!out.revoked, reason: out.error ?? null };
  }

  async _refreshIfNeeded(creds) {
    if (Date.now() < (creds.expiresAt ?? 0) - TOKEN_REFRESH_MARGIN_MS) return creds;
    if (!this._authno) throw new Error('Google Drive needs to be reconnected.');
    // Silent for an already-consented user; a consent sheet only on first use
    // or after the user revoked access in their Google account.
    const { accessToken } = await this._authno.auth.requestDriveToken();
    if (!accessToken) throw new Error('Google returned no access token.');
    return { ...creds, accessToken, expiresAt: Date.now() + 3600 * 1000 };
  }

  async isConnected(creds) {
    if (!creds?.accessToken) return false;
    try {
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      return res.ok;
    } catch { return false; }
  }

  // ── Folder management ─────────────────────────────────────────────────────

  async _getOrCreateFolder(creds) {
    // Search for existing AuthNo folder
    const search = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=` +
      encodeURIComponent(`name='${GDRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`) +
      `&fields=files(id)`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } }
    );
    if (!search.ok) {
      const body = await search.text().catch(() => '');
      throw new Error(`GDrive folder search failed (${search.status}): ${body}`);
    }
    const { files } = await search.json();
    if (files?.length) return files[0].id;

    // Create the folder
    const create = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name:     GDRIVE_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });
    if (!create.ok) {
      const body = await create.text().catch(() => '');
      throw new Error(`GDrive folder creation failed (${create.status}): ${body}`);
    }
    const folder = await create.json();
    return folder.id;
  }

  async _findFile(sessionId, folderId, creds) {
    // Search by name contains sessionId — supports both old ({sessionId}.authbook)
    // and new ({title}_{sessionId}.authbook) filename formats.
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=` +
      encodeURIComponent(`name contains '${sessionId}' and '${folderId}' in parents and trashed=false`) +
      `&fields=files(id,name,modifiedTime)`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } }
    );
    if (!res.ok) return null;
    const { files } = await res.json();
    // Prefer an exact match (name ends with _{sessionId}.authbook or is {sessionId}.authbook)
    const exact = files?.find(f =>
      f.name === `${sessionId}.authbook` || f.name.endsWith(`_${sessionId}.authbook`)
    );
    return exact ?? files?.[0] ?? null;
  }

  /** Sanitise a book title for use in a filename: strip Drive-illegal chars, trim, cap length. */
  _safeTitle(raw) {
    return (raw || 'Untitled')
      .replace(/[/\\:*?"<>|]/g, '')   // chars illegal in most filesystems / Drive
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'Untitled';
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  async upload(entry, creds, base64) {
    creds = await this._refreshIfNeeded(creds);
    const folderId = await this._getOrCreateFolder(creds);
    const existing = await this._findFile(entry.sessionId, folderId, creds);

    // Conflict check
    if (existing) {
      const remoteTime   = new Date(existing.modifiedTime).getTime();
      const lastUploaded = entry.lastUploadedAt ? new Date(entry.lastUploadedAt).getTime() : 0;
      if (remoteTime > lastUploaded + 5000) {
        return { ok: false, conflict: true, cloudModified: existing.modifiedTime };
      }
    }

    const bytes    = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const boundary = '-------AuthNoUpload';
    // Human-readable filename: {SafeTitle}_{sessionId}.authbook
    const name     = `${this._safeTitle(entry.title)}_${entry.sessionId}.authbook`;

    const metadata = JSON.stringify({
      name,
      ...(existing ? {} : { parents: [folderId] }),
    });

    // Multipart upload
    const body = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      metadata,
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      bytes,
      `\r\n--${boundary}--`,
    ];

    const url = existing
      ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;

    const res = await fetch(url, {
      method:  existing ? 'PATCH' : 'POST',
      headers: {
        Authorization:  `Bearer ${creds.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: new Blob(body),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GDrive upload failed (${res.status}): ${body}`);
    }
    return { ok: true };
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  async getFileMeta(sessionId, creds) {
    creds = await this._refreshIfNeeded(creds);
    try {
      const folderId = await this._getOrCreateFolder(creds);
      const file     = await this._findFile(sessionId, folderId, creds);
      if (!file) return null;
      return { modifiedTime: file.modifiedTime };
    } catch { return null; }
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async listFiles(creds) {
    creds = await this._refreshIfNeeded(creds);
    const folderId = await this._getOrCreateFolder(creds);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=` +
      encodeURIComponent(`'${folderId}' in parents and name contains '.authbook' and trashed=false`) +
      `&fields=files(id,name,modifiedTime,size)&pageSize=1000`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GDrive list failed (${res.status}): ${body}`);
    }
    const { files = [] } = await res.json();
    return files.map(f => {
      // Support both old format ({sessionId}.authbook) and new ({Title}_{sessionId}.authbook)
      const withoutExt   = f.name.replace(/^authno_/, '').replace(/\.authbook$/, '');
      // If the stem contains an underscore followed by what looks like a UUID/timestamp,
      // the last underscore-delimited segment is the sessionId and everything before is the title.
      const uuidishRe    = /^[0-9a-f\-]{8,}$/i;
      const underscoreAt = withoutExt.lastIndexOf('_');
      const lastSegment  = underscoreAt >= 0 ? withoutExt.slice(underscoreAt + 1) : '';
      const sessionId    = (uuidishRe.test(lastSegment) && underscoreAt > 0)
        ? lastSegment
        : withoutExt;   // old format — whole stem is the sessionId
      const displayName  = (uuidishRe.test(lastSegment) && underscoreAt > 0)
        ? withoutExt.slice(0, underscoreAt).replace(/_/g, ' ')
        : withoutExt;

      return {
        name:         f.name,
        displayName,
        sessionId,
        modifiedTime: f.modifiedTime,
        size:         parseInt(f.size ?? '0', 10),
        _fileId:      f.id,
      };
    });
  }

  // ── Download ──────────────────────────────────────────────────────────────

  async download(sessionId, creds) {
    creds = await this._refreshIfNeeded(creds);
    const folderId = await this._getOrCreateFolder(creds);
    const file     = await this._findFile(sessionId, folderId, creds);
    if (!file) throw new Error(`GDrive: file not found for session ${sessionId}`);

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GDrive download failed (${res.status}): ${body}`);
    }

    const buf = await res.arrayBuffer();
    // RC-5 FIX: chunked conversion — safe for large .authbook files
    const b64 = arrayBufferToBase64(buf);
    return { base64: b64, modifiedAt: file.modifiedTime ?? new Date().toISOString() };
  }

  // ── Raw upload (for "Export to cloud" feature) ────────────────────────────

  /**
   * Upload any file to the AuthNo Drive folder under an arbitrary filename.
   * Used by Settings.js "Export to cloud" (txt/html/epub), unlike upload()
   * which always targets the per-session .authbook path.
   */
  async uploadRaw(filename, base64, creds) {
    creds = await this._refreshIfNeeded(creds);
    const folderId = await this._getOrCreateFolder(creds);

    // Check if a file with this name already exists in the folder
    const search = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=` +
      encodeURIComponent(`name='${filename}' and '${folderId}' in parents and trashed=false`) +
      `&fields=files(id)`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } }
    );
    const { files = [] } = search.ok ? await search.json() : {};
    const existing = files[0] ?? null;

    const bytes    = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const boundary = '-------AuthNoRawUpload';
    const metadata = JSON.stringify({
      name: filename,
      ...(existing ? {} : { parents: [folderId] }),
    });
    const body = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      metadata,
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      bytes,
      `\r\n--${boundary}--`,
    ];
    const url = existing
      ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
    const res = await fetch(url, {
      method:  existing ? 'PATCH' : 'POST',
      headers: {
        Authorization:  `Bearer ${creds.accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: new Blob(body),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GDrive uploadRaw failed (${res.status}): ${body}`);
    }
  }
}
