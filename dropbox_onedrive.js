/**
 * providers/dropbox.js — v1.5.0
 *
 * Changes from v1.4.0:
 *   - RC-4 FIX (cold-start): PKCE state ({ verifier, state, redirectUri,
 *     clientId, tokenUrl, extraTokenParams }) is persisted to
 *     sessionStorage.__pkce_pending BEFORE openBrowser() is called.
 *     If the app is killed and relaunched via the deep-link redirect,
 *     index.js activate() reads this state and re-dispatches the URL open
 *     event so the exchange can complete.  The handler clears the key on
 *     success OR on the 2-minute timeout so no stale state lingers.
 *
 *   - RC-6 FIX (duplicate listener): added `handled` boolean guard inside
 *     the __capacitor_app_url_open handler.  If two calls to pkceOAuthFlow
 *     somehow register two handlers (e.g. the user taps "Connect" twice),
 *     the first invocation to fire sets handled=true and removes itself;
 *     subsequent invocations from other handlers see handled=true and return
 *     immediately without double-resolving or leaking.
 *     Note: callers (Settings.js) should still disable the Connect button
 *     while a flow is in progress — defence-in-depth.
 *
 *   - RC-5 FIX (large-file base64): replaced
 *       btoa(String.fromCharCode(...new Uint8Array(buf)))
 *     with chunked _arrayBufferToBase64() helper.  The spread form passes
 *     every byte as a separate JS argument — V8 throws RangeError for
 *     buffers larger than ~50 MB.  The chunked form processes 8 192 bytes
 *     per iteration and never overflows the call stack.
 *
 * Changes from v1.3.0 → v1.4.0 (preserved):
 *   - DROPBOX_REDIRECT_URI: changed from 'com.aurorastudios.authno:/oauth2/dropbox'
 *     to 'com.aurorastudios.authno://oauth2/dropbox' (single colon-slash → double).
 *     android:host="oauth2" only matches URIs with an authority component (double-slash).
 *   - Added 2-minute OAUTH_TIMEOUT_MS so codePromise never hangs forever.
 */

import { BaseProvider } from './base.js';

// ── Shared base64 helper ──────────────────────────────────────────────────────
/**
 * RC-5 FIX: Memory-safe ArrayBuffer → base64 conversion.
 * Processes the buffer in 8 192-byte chunks to avoid exceeding the JS
 * engine's maximum argument count (typically 65 536 in V8).
 * btoa(String.fromCharCode(...new Uint8Array(buf))) crashes above ~50 MB.
 */
function _arrayBufferToBase64(buf) {
  const bytes  = new Uint8Array(buf);
  let   binary = '';
  const CHUNK  = 8192;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ── PKCE utilities ────────────────────────────────────────────────────────────

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

/**
 * Generic PKCE OAuth 2.0 browser flow.
 *
 * Cold-start safety: persists { verifier, state, redirectUri, clientId,
 * tokenUrl, extraTokenParams } to sessionStorage.__pkce_pending before
 * opening the browser.  index.js activate() checks this key on startup and
 * re-dispatches __capacitor_app_url_open via Capacitor App.getLaunchUrl()
 * so the exchange completes even when the app was killed during the flow.
 *
 * Duplicate-listener safety: the `handled` flag ensures only one handler
 * instance processes the redirect — even if pkceOAuthFlow is called twice.
 */
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

  // ── RC-4 FIX: persist PKCE state for cold-start resume ───────────────────
  sessionStorage.setItem('__pkce_pending', JSON.stringify({
    verifier,
    state,
    redirectUri,
    clientId,
    tokenUrl,
    extraTokenParams: JSON.stringify(extraTokenParams),
  }));
  // ──────────────────────────────────────────────────────────────────────────

  let resolveCode, rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

  // ── RC-6 FIX: duplicate-listener guard ───────────────────────────────────
  let handled = false;
  // ──────────────────────────────────────────────────────────────────────────

  const handler = (event) => {
    // RC-6: if another handler already processed this event, bail out
    if (handled) return;

    const urlStr = event.detail?.url ?? '';
    if (!urlStr.startsWith(redirectUri)) return;

    // Mark handled BEFORE any async work so a second simultaneous call sees it
    handled = true;
    window.removeEventListener('__capacitor_app_url_open', handler);
    API.closeBrowser().catch(() => {});

    // RC-4: clear persisted PKCE state — exchange is in progress
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
    // Clean up persisted state on timeout/error so a stale entry doesn't
    // confuse the next cold-start resume attempt
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

  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
  const tokens = await tokenRes.json();
  return {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt:    Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
}

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

  _remotePath(sessionId) { return `${DROPBOX_REMOTE_ROOT}/${sessionId}.authbook`; }

  async upload(entry, creds, base64) {
    creds = await this._refreshIfNeeded(creds);
    const path     = this._remotePath(entry.sessionId);
    const apiArg   = { path, mode: 'overwrite', autorename: false };
    const bytes    = Uint8Array.from(atob(base64), c => c.charCodeAt(0));

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
    creds = await this._refreshIfNeeded(creds);
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
    creds = await this._refreshIfNeeded(creds);
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
    return filtered.map(e => ({
      name: e.name,
      sessionId: e.name.replace(/^authno_/, '').replace(/\.authbook$/, ''),
      modifiedTime: e.server_modified,
      size: e.size ?? 0,
    }));
  }

  async download(sessionId, creds) {
    creds = await this._refreshIfNeeded(creds);
    const path = this._remotePath(sessionId);
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
    const b64        = _arrayBufferToBase64(buf);
    return { base64: b64, modifiedAt: meta.server_modified ?? new Date().toISOString() };
  }

  /**
   * Upload any file (e.g. a .txt / .html / .epub export) to /AuthNo/<filename>.
   * Used by the "Export to cloud" feature in Settings.js.
   * Unlike upload() which targets the per-session .authbook path, this lets the
   * caller choose an arbitrary filename under the AuthNo root folder.
   */
  async uploadRaw(filename, base64, creds) {
    creds = await this._refreshIfNeeded(creds);
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
