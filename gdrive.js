/**
 * providers/gdrive.js — v2.0.0
 *
 * BREAKING CHANGE from v1.x:
 *   Replaced native GoogleSignIn Capacitor plugin with browser PKCE OAuth
 *   (same approach as DropboxProvider).
 *
 *   Root cause of "Google sign-in was cancelled" (Images 2 + 3):
 *   ─────────────────────────────────────────────────────────────
 *   The previous implementation called:
 *     window.Capacitor.Plugins.GoogleSignIn.signIn({ clientId })
 *   The plugin parameter is `webClientId`, not `clientId`. Passing an
 *   unknown key caused the plugin to fall back to the `google-services.json`
 *   web_client entry — which was either missing or had a mismatched
 *   redirect_uri/SHA-1 fingerprint. Android's GoogleSignIn activity completed
 *   with RESULT_CANCELED instead of RESULT_OK, and the plugin threw
 *   "Google sign-in was cancelled".
 *
 *   Even with a correct webClientId, the native flow requires a server-side
 *   token exchange for Drive scopes — inappropriate for a mobile-only app
 *   with no backend. Using browser PKCE (RFC 7636) is the correct approach:
 *   it's publicly documented by Google for mobile/native apps, returns both
 *   access_token AND refresh_token directly, and needs no server endpoint.
 *
 *   Migration checklist:
 *   ─────────────────────────────────────────────────────────────
 *   1. In Google Cloud Console → OAuth 2.0 Clients:
 *      • Create or select the "Web application" client.
 *      • Under "Authorized redirect URIs" add:
 *          com.aurorastudios.authno://oauth2/gdrive
 *      • Copy the Web client ID into GDRIVE_WEB_CLIENT_ID below.
 *   2. In AndroidManifest.xml add an intent-filter for the gdrive path:
 *          <data android:scheme="com.aurorastudios.authno"
 *                android:host="oauth2"
 *                android:pathPrefix="/gdrive"/>
 *      (The existing dropbox filter already covers android:host="oauth2";
 *      just add the pathPrefix="/gdrive" variant alongside it.)
 *   3. Remove the @codetrix-studio/capacitor-google-auth plugin dependency
 *      — it is no longer used by this extension.
 *
 *   Token refresh:
 *   ─────────────────────────────────────────────────────────────
 *   Google refresh tokens for mobile PKCE flows do not expire as long as
 *   the app is used at least once every 6 months and the user hasn't revoked
 *   access.  connect() always passes prompt=consent to guarantee a fresh
 *   refresh_token on each explicit connect action.
 */

import { BaseProvider } from './base.js';

// ── Shared base64 helper (RC-5 FIX: large-file safe) ─────────────────────────
function _arrayBufferToBase64(buf) {
  const bytes  = new Uint8Array(buf);
  let   binary = '';
  const CHUNK  = 8192;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── Native Drive token helper ─────────────────────────────────────────────────
//
// Calls GoogleDrivePlugin.requestDriveToken() which uses the Google Identity
// Authorization API (play-services-auth) to get an access token for drive.file.
//
// On first call: shows a native consent bottom-sheet (no browser, no custom scheme).
// On subsequent calls: returns a fresh token silently if already authorized.
// No refresh token or client secret needed — Identity.authorize() handles renewal.

async function getNativeDriveToken() {
  const plugin = window.Capacitor?.Plugins?.GoogleDrive;
  if (!plugin?.requestDriveToken) {
    throw new Error(
      'GoogleDrive native plugin not available. ' +
      'Make sure GoogleDrivePlugin is registered in MainActivity.java ' +
      'and the app has been rebuilt.'
    );
  }
  const result = await plugin.requestDriveToken();
  if (!result?.accessToken) {
    throw new Error('GoogleDrive plugin returned no access token');
  }
  return result.accessToken;
}

// Token validity window: refresh if less than 5 minutes remain.
// Identity.authorize() is called each time the token nears expiry — it is
// fast (no UI) for already-authorized users and only shows UI on first use
// or if the user revokes access.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ── GOOGLE DRIVE ──────────────────────────────────────────────────────────────

// No client ID constant needed — the native GoogleDrivePlugin calls
// Identity.getAuthorizationClient().authorize() which uses the app's own
// Play Services identity, verified by the SHA-1 fingerprint and package name
// already registered in Google Cloud Console under "Authno Android".
// No redirect URI, no client secret, no browser tab.
const GDRIVE_SCOPE       = 'https://www.googleapis.com/auth/drive.file'; // kept for reference
const GDRIVE_FOLDER_NAME = 'AuthNo';

export class GDriveProvider extends BaseProvider {
  constructor() { super('gdrive'); }
  get name() { return 'Google Drive'; }
  get icon() { return 'HardDrive'; }

  async connect(_config) {
    // Uses native GoogleDrivePlugin (Identity Authorization API).
    // No browser, no custom scheme, no client secret.
    // Shows a native consent UI on first use; silent on subsequent calls.
    const accessToken = await getNativeDriveToken();
    return { accessToken, expiresAt: Date.now() + 3600 * 1000 };
  }

  async disconnect(storage) { await this.clearCreds(storage); }

  async _refreshIfNeeded(creds) {
    // Token is still valid — reuse it.
    if (Date.now() < (creds.expiresAt ?? 0) - TOKEN_REFRESH_MARGIN_MS) return creds;
    // Token is near expiry or missing — ask Identity API for a fresh one.
    // For already-consented users this is instant (no UI shown).
    const accessToken = await getNativeDriveToken();
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
    const name = `${sessionId}.authbook`;
    const res  = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=` +
      encodeURIComponent(`name='${name}' and '${folderId}' in parents and trashed=false`) +
      `&fields=files(id,modifiedTime)`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } }
    );
    if (!res.ok) return null;
    const { files } = await res.json();
    return files?.[0] ?? null;
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
    const name     = `${entry.sessionId}.authbook`;

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
    return files.map(f => ({
      name:         f.name,
      sessionId:    f.name.replace(/^authno_/, '').replace(/\.authbook$/, ''),
      modifiedTime: f.modifiedTime,
      size:         parseInt(f.size ?? '0', 10),
      _fileId:      f.id,
    }));
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
    const b64 = _arrayBufferToBase64(buf);
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
