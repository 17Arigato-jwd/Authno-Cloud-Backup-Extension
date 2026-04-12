/**
 * providers/dropbox_onedrive.js — v1.2.0
 *
 * Changes from v1.1.0:
 *   - pkceOAuthFlow(): replaced App.addListener('appUrlOpen') with
 *     window.addEventListener('__capacitor_app_url_open'). Same fix as
 *     gdrive.js — Capacitor plugin bus vs DOM CustomEvent mismatch.
 *   - Dropbox/OneDrive placeholder client IDs left unchanged pending
 *     registration in their respective developer consoles.
 */

import { BaseProvider } from './base.js';

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

async function pkceOAuthFlow({ authUrl, tokenUrl, clientId, redirectUri, extraTokenParams = {} }) {
  const verifier  = randomBase64url(64);
  const challenge = await sha256Base64url(verifier);
  const state     = randomBase64url(16);

  const fullAuthUrl = authUrl + '&' + new URLSearchParams({
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state,
  });

  const { Browser } = await import('@capacitor/browser');

  let resolveCode, rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

  // ── FIX: DOM CustomEvent, not Capacitor App plugin bus ───────────────────
  const handler = (event) => {
    const urlStr = event.detail?.url ?? '';
    if (!urlStr.startsWith(redirectUri)) return;

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
  await Browser.open({ url: fullAuthUrl });

  let code;
  try {
    code = await codePromise;
  } catch (err) {
    window.removeEventListener('__capacitor_app_url_open', handler);
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

  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
  const tokens = await tokenRes.json();
  return {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt:    Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

// ── DROPBOX ───────────────────────────────────────────────────────────────────

const DROPBOX_CLIENT_ID    = '__DROPBOX_CLIENT_ID__';
const DROPBOX_REDIRECT_URI = 'com.aurorastudios.authno:/oauth2/dropbox';
const DROPBOX_REMOTE_ROOT  = '/AuthNo';

export class DropboxProvider extends BaseProvider {
  constructor() { super('dropbox'); }
  get name() { return 'Dropbox'; }
  get icon() { return 'Box'; }

  async connect(_config) {
    return pkceOAuthFlow({
      authUrl: 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
        client_id:         DROPBOX_CLIENT_ID,
        redirect_uri:      DROPBOX_REDIRECT_URI,
        response_type:     'code',
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
    if (!res.ok) throw new Error('Dropbox token refresh failed');
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

  _remotePath(sessionId) { return `${DROPBOX_REMOTE_ROOT}/${sessionId}.authbook`; }

  async upload(entry, creds, base64) {
    creds = await this._refreshIfNeeded(creds);
    const path  = this._remotePath(entry.sessionId);
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

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
        if (remoteTime > lastUploaded + 5000) {
          return { ok: false, conflict: true, cloudModified: meta.server_modified };
        }
      }
    } catch { /* file doesn't exist yet */ }

    const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization:     `Bearer ${creds.accessToken}`,
        'Content-Type':    'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', autorename: false }),
      },
      body: bytes,
    });

    if (!uploadRes.ok) throw new Error(`Dropbox upload failed: ${uploadRes.status}`);
    return { ok: true };
  }

  async download(sessionId, creds) {
    creds = await this._refreshIfNeeded(creds);
    const path = this._remotePath(sessionId);

    const res = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        Authorization:     `Bearer ${creds.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
    });
    if (!res.ok) throw new Error(`Dropbox download failed: ${res.status}`);

    const metaHeader = res.headers.get('dropbox-api-result');
    const meta       = metaHeader ? JSON.parse(metaHeader) : {};
    const buf        = await res.arrayBuffer();
    const b64        = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return { base64: b64, modifiedAt: meta.server_modified ?? new Date().toISOString() };
  }
}

// ── ONEDRIVE ──────────────────────────────────────────────────────────────────

const OD_CLIENT_ID    = '__ONEDRIVE_CLIENT_ID__';
const OD_REDIRECT_URI = 'com.aurorastudios.authno:/oauth2/onedrive';
const OD_TOKEN_URL    = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const OD_FOLDER       = 'AuthNo';

export class OneDriveProvider extends BaseProvider {
  constructor() { super('onedrive'); }
  get name() { return 'OneDrive'; }
  get icon() { return 'Cloud'; }

  async connect(_config) {
    return pkceOAuthFlow({
      authUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?' + new URLSearchParams({
        client_id:     OD_CLIENT_ID,
        redirect_uri:  OD_REDIRECT_URI,
        response_type: 'code',
        scope:         'Files.ReadWrite.AppFolder offline_access',
      }),
      tokenUrl:    OD_TOKEN_URL,
      clientId:    OD_CLIENT_ID,
      redirectUri: OD_REDIRECT_URI,
    });
  }

  async disconnect(storage) { await this.clearCreds(storage); }

  async _refreshIfNeeded(creds) {
    if (Date.now() < creds.expiresAt - 60_000) return creds;
    const res = await fetch(OD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     OD_CLIENT_ID,
        grant_type:    'refresh_token',
        refresh_token: creds.refreshToken,
        scope:         'Files.ReadWrite.AppFolder offline_access',
      }),
    });
    if (!res.ok) throw new Error('OneDrive token refresh failed');
    const tokens = await res.json();
    return { ...creds, accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  }

  async isConnected(creds) {
    if (!creds?.accessToken) return false;
    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/me/drive', {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      });
      return res.ok;
    } catch { return false; }
  }

  _itemPath(sessionId) {
    return `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${OD_FOLDER}/${sessionId}.authbook`;
  }

  async upload(entry, creds, base64) {
    creds = await this._refreshIfNeeded(creds);
    const auth  = `Bearer ${creds.accessToken}`;
    const path  = this._itemPath(entry.sessionId);
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

    try {
      const metaRes = await fetch(`${path}:/`, { headers: { Authorization: auth } });
      if (metaRes.ok) {
        const meta         = await metaRes.json();
        const remoteTime   = new Date(meta.lastModifiedDateTime).getTime();
        const lastUploaded = entry.lastUploadedAt ? new Date(entry.lastUploadedAt).getTime() : 0;
        if (remoteTime > lastUploaded + 5000) {
          return { ok: false, conflict: true, cloudModified: meta.lastModifiedDateTime };
        }
      }
    } catch { /* file doesn't exist yet */ }

    const uploadRes = await fetch(`${path}:/content`, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });

    if (!uploadRes.ok) throw new Error(`OneDrive upload failed: ${uploadRes.status}`);
    return { ok: true };
  }

  async download(sessionId, creds) {
    creds = await this._refreshIfNeeded(creds);
    const auth = `Bearer ${creds.accessToken}`;
    const path = this._itemPath(sessionId);

    const metaRes = await fetch(`${path}:/`, { headers: { Authorization: auth } });
    if (!metaRes.ok) throw new Error('File not found in OneDrive AuthNo folder');
    const meta = await metaRes.json();

    const dlRes = await fetch(meta['@microsoft.graph.downloadUrl']);
    if (!dlRes.ok) throw new Error(`OneDrive download failed: ${dlRes.status}`);

    const buf    = await dlRes.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return { base64, modifiedAt: meta.lastModifiedDateTime };
  }
}
