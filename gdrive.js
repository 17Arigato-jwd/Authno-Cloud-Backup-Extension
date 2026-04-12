/**
 * providers/gdrive.js — v1.2.0
 *
 * Changes from v1.1.0:
 *   - connect(): replaced App.addListener('appUrlOpen') with
 *     window.addEventListener('__capacitor_app_url_open'). MainActivity.java
 *     dispatches a DOM CustomEvent on that name; Capacitor's App plugin bus
 *     is a completely separate channel and never received the redirect.
 *     This was the primary reason Google Drive OAuth always hung forever.
 *   - _refreshIfNeeded(): unchanged — token refresh logic is correct.
 *   - upload()/download(): callers now use provider.refreshCreds(storage)
 *     before calling, so these methods receive already-fresh creds and the
 *     internal _refreshIfNeeded() call is a fast no-op.
 */

import { BaseProvider } from './base.js';

const CLIENT_ID    = '779756818797-gg0m357ri7j20evljv4bv3madkoh6ojn.apps.googleusercontent.com';
const REDIRECT_URI = 'com.aurorastudios.authno:/oauth2/gdrive';
const SCOPE        = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const API_BASE     = 'https://www.googleapis.com';
const FOLDER_NAME  = 'AuthNo';

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

function remoteFileName(sessionId) {
  return `authno_${sessionId}.authbook`;
}

export class GDriveProvider extends BaseProvider {
  constructor() { super('gdrive'); }
  get name() { return 'Google Drive'; }
  get icon() { return 'HardDrive'; }

  async connect(_config) {
    const verifier  = randomBase64url(64);
    const challenge = await sha256Base64url(verifier);
    const state     = randomBase64url(16);

    const params = new URLSearchParams({
      client_id:             CLIENT_ID,
      redirect_uri:          REDIRECT_URI,
      response_type:         'code',
      scope:                 SCOPE,
      code_challenge:        challenge,
      code_challenge_method: 'S256',
      state,
      access_type:           'offline',
      prompt:                'consent',
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

    const { Browser } = await import('@capacitor/browser');

    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

    // ── FIX: listen on the DOM CustomEvent dispatched by MainActivity ─────
    // Previously used App.addListener('appUrlOpen') which is the Capacitor
    // native plugin bus — a completely different channel. MainActivity fires
    // window.dispatchEvent(new CustomEvent('__capacitor_app_url_open', ...))
    // so we must listen here, not on the Capacitor App plugin.
    const handler = (event) => {
      const urlStr = event.detail?.url ?? '';
      if (!urlStr.startsWith(REDIRECT_URI)) return;

      window.removeEventListener('__capacitor_app_url_open', handler);
      Browser.close().catch(() => {});

      const url      = new URL(urlStr);
      const code     = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');

      if (gotState !== state) { rejectCode(new Error('State mismatch')); return; }
      if (!code)              { rejectCode(new Error('No auth code'));    return; }
      resolveCode(code);
    };

    window.addEventListener('__capacitor_app_url_open', handler);

    await Browser.open({ url: authUrl });

    let code;
    try {
      code = await codePromise;
    } catch (err) {
      window.removeEventListener('__capacitor_app_url_open', handler);
      throw err;
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
        code,
        code_verifier: verifier,
      }),
    });

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokens = await tokenRes.json();

    return {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt:    Date.now() + tokens.expires_in * 1000,
    };
  }

  async disconnect(storage) {
    const creds = await this.loadCreds(storage);
    if (creds?.accessToken) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${creds.accessToken}`, { method: 'POST' }).catch(() => {});
    }
    await this.clearCreds(storage);
  }

  async _refreshIfNeeded(creds) {
    if (Date.now() < creds.expiresAt - 60_000) return creds;
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        grant_type:    'refresh_token',
        refresh_token: creds.refreshToken,
      }),
    });
    if (!res.ok) throw new Error('Token refresh failed');
    const tokens = await res.json();
    return {
      ...creds,
      accessToken: tokens.access_token,
      expiresAt:   Date.now() + tokens.expires_in * 1000,
    };
  }

  async isConnected(creds) {
    if (!creds?.refreshToken) return false;
    try {
      const fresh = await this._refreshIfNeeded(creds);
      return !!fresh.accessToken;
    } catch { return false; }
  }

  async _getOrCreateFolder(auth) {
    const q = encodeURIComponent(
      `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const searchRes = await fetch(
      `${API_BASE}/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`,
      { headers: { Authorization: auth } }
    );
    if (!searchRes.ok) throw new Error(`Folder search failed: ${searchRes.status}`);
    const { files } = await searchRes.json();
    if (files?.length) return files[0].id;

    const createRes = await fetch(`${API_BASE}/drive/v3/files`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    if (!createRes.ok) throw new Error(`Folder creation failed: ${createRes.status}`);
    return (await createRes.json()).id;
  }

  async upload(entry, creds, base64) {
    // Callers use provider.refreshCreds(storage) before upload; this is a fast no-op.
    creds = await this._refreshIfNeeded(creds);
    const auth     = `Bearer ${creds.accessToken}`;
    const fname    = remoteFileName(entry.sessionId);
    const folderId = await this._getOrCreateFolder(auth);

    const q = encodeURIComponent(
      `name='${fname}' and '${folderId}' in parents and trashed=false`
    );
    const searchRes = await fetch(
      `${API_BASE}/drive/v3/files?q=${q}&fields=files(id,modifiedTime)&spaces=drive`,
      { headers: { Authorization: auth } }
    );
    if (!searchRes.ok) throw new Error(`Drive search failed: ${searchRes.status}`);
    const { files } = await searchRes.json();
    const existing = files?.[0];

    if (existing) {
      const remoteTime   = new Date(existing.modifiedTime).getTime();
      const lastUploaded = entry.lastUploadedAt ? new Date(entry.lastUploadedAt).getTime() : 0;
      if (remoteTime > lastUploaded + 5000) {
        return { ok: false, conflict: true, cloudModified: existing.modifiedTime };
      }
    }

    const bytes    = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const boundary = 'authno_boundary_xk8';
    const meta     = JSON.stringify(
      existing ? { name: fname } : { name: fname, parents: [folderId] }
    );

    const part1   = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`);
    const part2   = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const endPart = new TextEncoder().encode(`\r\n--${boundary}--`);

    const merged = new Uint8Array(part1.length + part2.length + bytes.length + endPart.length);
    let off = 0;
    merged.set(part1,   off); off += part1.length;
    merged.set(part2,   off); off += part2.length;
    merged.set(bytes,   off); off += bytes.length;
    merged.set(endPart, off);

    const uploadUrl = existing
      ? `${API_BASE}/upload/drive/v3/files/${existing.id}?uploadType=multipart`
      : `${API_BASE}/upload/drive/v3/files?uploadType=multipart`;

    const uploadRes = await fetch(uploadUrl, {
      method:  existing ? 'PATCH' : 'POST',
      headers: { Authorization: auth, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: merged,
    });

    if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);
    return { ok: true };
  }

  async download(sessionId, creds) {
    creds = await this._refreshIfNeeded(creds);
    const auth     = `Bearer ${creds.accessToken}`;
    const fname    = remoteFileName(sessionId);
    const folderId = await this._getOrCreateFolder(auth);

    const q = encodeURIComponent(
      `name='${fname}' and '${folderId}' in parents and trashed=false`
    );
    const searchRes = await fetch(
      `${API_BASE}/drive/v3/files?q=${q}&fields=files(id,modifiedTime)&spaces=drive`,
      { headers: { Authorization: auth } }
    );
    const { files } = await searchRes.json();
    if (!files?.length) throw new Error('File not found in Drive AuthNo folder');

    const fileId = files[0].id;
    const dlRes  = await fetch(`${API_BASE}/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: auth },
    });
    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);

    const buf    = await dlRes.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return { base64, modifiedAt: files[0].modifiedTime };
  }
}
