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

// ── PKCE utilities (identical to dropbox_onedrive.js) ────────────────────────

function randomBase64url(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function sha256Base64url(str) {
  const enc  = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

const OAUTH_TIMEOUT_MS = 120_000; // 2 minutes

async function pkceOAuthFlow({ authUrl, tokenUrl, clientId, redirectUri, extraTokenParams = {} }) {
  const verifier  = randomBase64url(64);
  const challenge = await sha256Base64url(verifier);
  const state     = randomBase64url(16);

  const fullAuthUrl = authUrl + '&' + new URLSearchParams({
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state,
  });

  const API = window.CloudBackupAPI;
  if (!API?.openBrowser) throw new Error('CloudBackupAPI.openBrowser not available');

  // Persist PKCE state for cold-start resume (index.js activate() reads this)
  sessionStorage.setItem('__pkce_pending', JSON.stringify({
    verifier, state, redirectUri, clientId, tokenUrl,
    extraTokenParams: JSON.stringify(extraTokenParams),
  }));

  let resolveCode, rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
  let handled = false; // duplicate-listener guard

  const handler = (event) => {
    if (handled) return;
    const urlStr = event.detail?.url ?? '';
    if (!urlStr.startsWith(redirectUri)) return;
    handled = true;
    window.removeEventListener('__capacitor_app_url_open', handler);
    API.closeBrowser().catch(() => {});
    sessionStorage.removeItem('__pkce_pending');
    const url      = new URL(urlStr);
    const code     = url.searchParams.get('code');
    const gotState = url.searchParams.get('state');
    if (gotState !== state) { rejectCode(new Error('State mismatch')); return; }
    if (!code)              { rejectCode(new Error('No auth code'));    return; }
    resolveCode(code);
  };

  window.addEventListener('__capacitor_app_url_open', handler);
  await API.openBrowser(fullAuthUrl);

  let code;
  try {
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('OAuth timed out — please try again')), OAUTH_TIMEOUT_MS)
    );
    code = await Promise.race([codePromise, timeout]);
  } catch (err) {
    window.removeEventListener('__capacitor_app_url_open', handler);
    API.closeBrowser().catch(() => {});
    sessionStorage.removeItem('__pkce_pending');
    throw err;
  }

  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
      code,
      code_verifier: verifier,
      ...extraTokenParams,
    }),
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text().catch(() => '');
    throw new Error(`Token exchange failed (${tokenRes.status}): ${errBody}`);
  }
  const tokens = await tokenRes.json();
  if (!tokens.refresh_token) {
    // This should not happen with prompt=consent, but guard explicitly
    throw new Error('Google did not return a refresh token. Please disconnect and reconnect to re-grant consent.');
  }
  return {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt:    Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

// ── GOOGLE DRIVE ──────────────────────────────────────────────────────────────

// IMPORTANT: Use the WEB application client ID from Google Cloud Console,
// not the Android client ID. The web client ID is required for PKCE flows
// that exchange a code for tokens directly (no server middleman).
const GDRIVE_WEB_CLIENT_ID = '779756818797-l24cufifasq14irv0tj6sf4p1q9rnpva.apps.googleusercontent.com';
const GDRIVE_REDIRECT_URI  = 'com.aurorastudios.authno://oauth2/gdrive';
const GDRIVE_SCOPE         = 'https://www.googleapis.com/auth/drive.file';
const GDRIVE_FOLDER_NAME   = 'AuthNo';

export class GDriveProvider extends BaseProvider {
  constructor() { super('gdrive'); }
  get name() { return 'Google Drive'; }
  get icon() { return 'HardDrive'; }

  async connect(_config) {
    return pkceOAuthFlow({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id:     GDRIVE_WEB_CLIENT_ID,
        redirect_uri:  GDRIVE_REDIRECT_URI,
        response_type: 'code',
        scope:         GDRIVE_SCOPE,
        access_type:   'offline',
        prompt:        'consent',   // always request refresh_token
      }),
      tokenUrl:    'https://oauth2.googleapis.com/token',
      clientId:    GDRIVE_WEB_CLIENT_ID,
      redirectUri: GDRIVE_REDIRECT_URI,
    });
  }

  async disconnect(storage) { await this.clearCreds(storage); }

  async _refreshIfNeeded(creds) {
    if (Date.now() < creds.expiresAt - 60_000) return creds;
    if (!creds.refreshToken) throw new Error('No Google refresh token — please reconnect Google Drive.');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     GDRIVE_WEB_CLIENT_ID,
        grant_type:    'refresh_token',
        refresh_token: creds.refreshToken,
      }),
    });
    if (!res.ok) throw new Error('Google Drive token refresh failed — please reconnect.');
    const tokens = await res.json();
    return {
      ...creds,
      accessToken: tokens.access_token,
      expiresAt:   Date.now() + (tokens.expires_in ?? 3600) * 1000,
    };
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
    if (!search.ok) throw new Error(`GDrive folder search failed: ${search.status}`);
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
    if (!create.ok) throw new Error(`GDrive folder creation failed: ${create.status}`);
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

    if (!res.ok) throw new Error(`GDrive upload failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`GDrive list failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`GDrive download failed: ${res.status}`);

    const buf = await res.arrayBuffer();
    // RC-5 FIX: chunked conversion — safe for large .authbook files
    const b64 = _arrayBufferToBase64(buf);
    return { base64: b64, modifiedAt: file.modifiedTime ?? new Date().toISOString() };
  }
}
