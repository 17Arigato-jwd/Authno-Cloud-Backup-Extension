/**
 * Settings.js — cloud-backup extension UI — v1.1.0
 *
 * Runs inside a sandboxed iframe managed by ExtensionPage's UiFilePage renderer.
 * window.CloudBackupAPI is injected as a postMessage shim by the host before
 * this script executes — no polling needed.
 *
 * Changes from v1.0.2:
 *   - Removed `const API = window.CloudBackupAPI` at module scope (was undefined)
 *   - All API calls now go through getAPI() which resolves after DOMContentLoaded
 *   - WebDAV form fields use explicit null checks instead of optional chaining
 *     (for maximum compatibility inside the iframe sandbox)
 */

// ── Provider definitions ──────────────────────────────────────────────────────

const PROVIDERS = [
  {
    key:   'gdrive',
    label: 'Google Drive',
    oAuth: true,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="22" height="22">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>`,
  },
  {
    key:   'onedrive',
    label: 'OneDrive',
    oAuth: true,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" width="22" height="22">
      <rect x="1"  y="1"  width="9" height="9" fill="#F25022"/>
      <rect x="11" y="1"  width="9" height="9" fill="#7FBA00"/>
      <rect x="1"  y="11" width="9" height="9" fill="#00A4EF"/>
      <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
    </svg>`,
  },
  {
    key:   'dropbox',
    label: 'Dropbox',
    oAuth: true,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="22" height="22">
      <path fill="#0061FF" d="M10 2.5L0 9.167l10 6.666 10-6.666zM30 2.5l-10 6.667 10 6.666 10-6.666zM0 22.5l10 6.667 10-6.667-10-6.666zM30 15.834l-10 6.666 10 6.667 10-6.667zM10 30.833L20 37.5l10-6.667-10-6.666z"/>
    </svg>`,
  },
  {
    key:   'webdav',
    label: 'WebDAV / Self-hosted',
    oAuth: false,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
    </svg>`,
  },
];

// ── Styles ───────────────────────────────────────────────────────────────────

document.head.insertAdjacentHTML('beforeend', `<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px; color: #e4e4f0; background: transparent; min-height: 100vh;
  }
  .login-screen {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; min-height: 100vh; padding: 32px 24px;
  }
  .login-title { font-size: 22px; font-weight: 700; margin-bottom: 6px; letter-spacing: -0.3px; }
  .login-sub { color: #9999aa; font-size: 13px; margin-bottom: 32px; text-align: center; max-width: 300px; line-height: 1.5; }
  .login-sub strong { color: #e4e4f0; }
  .section-label { font-size: 12px; font-weight: 600; color: #9999aa; letter-spacing: 0.6px; text-transform: uppercase; margin-bottom: 14px; align-self: flex-start; max-width: 360px; width: 100%; }
  .pill-btn {
    display: flex; align-items: center; gap: 14px; width: 100%; max-width: 360px;
    padding: 14px 20px; border-radius: 999px; border: 1.5px solid #3a3a4a;
    background: #1c1c26; color: #e4e4f0; cursor: pointer; font-size: 15px; font-weight: 500;
    margin-bottom: 12px; transition: border-color .15s, background .15s, transform .1s;
    text-align: left; -webkit-tap-highlight-color: transparent;
  }
  .pill-btn:hover  { border-color: #6366f1; background: #1f1f2e; }
  .pill-btn:active { transform: scale(0.98); }
  .pill-icon { width: 32px; height: 32px; border-radius: 50%; background: #111118; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .pill-label { flex: 1; }
  .pill-chevron { color: #4a4a5a; font-size: 16px; }
  .page { padding: 20px; max-width: 480px; margin: 0 auto; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .sub { color: #6b6b80; font-size: 13px; margin-bottom: 24px; line-height: 1.5; }
  .card { background: #1f1f2a; border: 1px solid #2e2e3a; border-radius: 12px; padding: 16px; margin-bottom: 12px; }
  .card h2 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: #6b6b80; margin-bottom: 4px; }
  .field input, .field select { width: 100%; background: #16161d; border: 1px solid #2e2e3a; color: #e4e4f0; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 500; }
  .btn-primary { background: #6366f1; color: #fff; }
  .btn-ghost   { background: #1f1f2a; border: 1px solid #2e2e3a; color: #e4e4f0; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot-synced  { background: #22c55e; }
  .dot-syncing { background: #eab308; animation: pulse 1s ease-in-out infinite; }
  .dot-error   { background: #ef4444; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .queue-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #2e2e3a; font-size: 12px; }
  .queue-row:last-child { border-bottom: none; }
  .attempt-label { color: #6b6b80; }
  .error-msg { color: #ef4444; font-size: 11px; margin-top: 2px; }
  .err-banner { color: #ef4444; font-size: 12px; margin-top: 10px; padding: 8px 12px; background: #ef444418; border-radius: 6px; border: 1px solid #ef444430; }
  .hidden { display: none !important; }
  .loading-state { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; gap: 12px; color: #6b6b80; font-size: 13px; }
</style>`);

// ── API accessor — safe at any point after DOMContentLoaded ───────────────────
//
// window.CloudBackupAPI is injected as a synchronous shim by UiFilePage's
// bridge script before this module executes. The getAPI() function is a
// safety net for any code that runs in an unusual order.

function getAPI() {
  if (window.CloudBackupAPI) return window.CloudBackupAPI;
  throw new Error('CloudBackupAPI bridge not available. The extension may not have activated correctly.');
}

// ── Render helpers ────────────────────────────────────────────────────────────

const root = document.body;

function renderProviderPicker() {
  const pillsHtml = PROVIDERS.map(p => `
    <button class="pill-btn" data-key="${p.key}">
      <span class="pill-icon">${p.svg}</span>
      <span class="pill-label">Sign in with ${p.label}</span>
      <span class="pill-chevron">›</span>
    </button>
  `).join('');

  root.innerHTML = `
    <div class="login-screen">
      <div style="font-size:32px;margin-bottom:12px">☁️</div>
      <div class="login-title">Cloud Backup</div>
      <p class="login-sub">
        Choose a provider to back up your books.<br>
        Files will be saved in a folder named <strong>AuthNo</strong>.
      </p>
      <div class="section-label">Log in with</div>
      ${pillsHtml}
    </div>
  `;

  root.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = PROVIDERS.find(p => p.key === btn.dataset.key);
      if (!p) return;
      p.oAuth ? renderOAuthConnect(p.key) : renderWebDAVForm();
    });
  });
}

function renderWebDAVForm() {
  root.innerHTML = `<div class="page">
    <h1>🖥️ WebDAV Setup</h1>
    <p class="sub">Connect to Nextcloud, ownCloud, Seafile, or any WebDAV server.
      Files will be saved under an <strong>AuthNo</strong> folder.</p>
    <div class="card">
      <div class="field">
        <label>Server URL</label>
        <input id="wdav-url" type="url" placeholder="https://cloud.example.com/remote.php/dav/files/user/">
      </div>
      <div class="field">
        <label>Auth type</label>
        <select id="wdav-auth">
          <option value="basic">Username + password</option>
          <option value="token">Bearer token</option>
        </select>
      </div>
      <div id="basic-fields">
        <div class="field"><label>Username</label><input id="wdav-user" type="text"></div>
        <div class="field"><label>Password</label><input id="wdav-pass" type="password"></div>
      </div>
      <div id="token-field" class="hidden">
        <div class="field"><label>Token</label><input id="wdav-token" type="password"></div>
      </div>
      <button class="btn btn-primary" id="wdav-connect">Connect</button>
      <span id="wdav-err"></span>
    </div>
    <button class="btn btn-ghost" id="wdav-back" style="margin-top:8px">← Back</button>
  </div>`;

  document.getElementById('wdav-auth').addEventListener('change', e => {
    const isToken = e.target.value === 'token';
    document.getElementById('basic-fields').classList.toggle('hidden', isToken);
    document.getElementById('token-field').classList.toggle('hidden', !isToken);
  });

  document.getElementById('wdav-back').addEventListener('click', renderProviderPicker);

  document.getElementById('wdav-connect').addEventListener('click', async () => {
    const authType = document.getElementById('wdav-auth').value;
    const userEl  = document.getElementById('wdav-user');
    const passEl  = document.getElementById('wdav-pass');
    const tokenEl = document.getElementById('wdav-token');
    const config = {
      baseUrl:  document.getElementById('wdav-url').value.trim(),
      authType,
      username: userEl  ? userEl.value  : '',
      password: passEl  ? passEl.value  : '',
      token:    tokenEl ? tokenEl.value : '',
    };
    const btn = document.getElementById('wdav-connect');
    const err = document.getElementById('wdav-err');
    btn.textContent = 'Connecting…';
    btn.disabled = true;
    err.textContent = '';
    try {
      await getAPI().connectProvider('webdav', config);
      renderConnectedView();
    } catch (e) {
      err.className = 'err-banner';
      err.textContent = e.message;
      btn.textContent = 'Connect';
      btn.disabled = false;
    }
  });
}

function renderOAuthConnect(providerKey) {
  const p = PROVIDERS.find(p => p.key === providerKey);

  root.innerHTML = `<div class="page">
    <h1>${p.label}</h1>
    <p class="sub">You'll be taken to ${p.label} to authorise Authno.<br>
      Files will be saved in a folder named <strong>AuthNo</strong> — nothing else is accessed.</p>
    <div style="display:flex;gap:10px;margin-top:8px">
      <button class="btn btn-primary" id="oauth-go">Connect with ${p.label}</button>
      <button class="btn btn-ghost" id="oauth-back">Cancel</button>
    </div>
    <div id="oauth-err"></div>
  </div>`;

  document.getElementById('oauth-back').addEventListener('click', renderProviderPicker);
  document.getElementById('oauth-go').addEventListener('click', async () => {
    const btn = document.getElementById('oauth-go');
    btn.textContent = 'Opening browser…';
    btn.disabled = true;
    try {
      await getAPI().connectProvider(providerKey, {});
      renderConnectedView();
    } catch (e) {
      const errEl = document.getElementById('oauth-err');
      if (errEl) { errEl.className = 'err-banner'; errEl.textContent = e.message; }
      btn.textContent = `Connect with ${p.label}`;
      btn.disabled = false;
    }
  });
}

async function renderConnectedView() {
  const { activeProvider, tileStatus, queueEntries } = await getAPI().getStatus();
  const p = PROVIDERS.find(p => p.key === activeProvider) || { label: activeProvider || 'Cloud', svg: '☁️' };
  const dotClass = `dot-${tileStatus}`;

  root.innerHTML = `<div class="page">
    <h1>☁️ Cloud Backup</h1>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px">
          <span>${p.svg || ''}</span>
          <div>
            <div style="font-weight:600">${p.label}</div>
            <div style="font-size:12px;color:#6b6b80;margin-top:2px">
              <span class="status-dot ${dotClass}"></span>
              ${tileStatus === 'synced'  ? 'All books backed up to AuthNo folder' :
                tileStatus === 'syncing' ? 'Syncing…' : 'Sync error — tap to retry'}
            </div>
          </div>
        </div>
        <button class="btn btn-ghost" id="btn-disconnect">Disconnect</button>
      </div>
    </div>

    ${queueEntries && queueEntries.length > 0 ? `
    <div class="card">
      <h2>Queue (${queueEntries.length})</h2>
      ${queueEntries.map(e => `
        <div class="queue-row">
          <div>
            <div>${e.title}</div>
            ${e.errorMsg ? `<div class="error-msg">${e.errorMsg}</div>` : ''}
          </div>
          <span class="attempt-label">${e.attempts}/5 attempts</span>
        </div>`).join('')}
    </div>` : ''}

    <p style="color:#6b6b80;font-size:12px;margin-top:16px">
      Books are backed up automatically after every auto-save.<br>
      Tokens are stored in the Android Keystore.
    </p>
  </div>`;

  const disconnectBtn = document.getElementById('btn-disconnect');
  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', async () => {
      await getAPI().disconnectProvider();
      renderProviderPicker();
    });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    const { activeProvider } = await getAPI().getStatus();
    if (activeProvider) {
      await renderConnectedView();
    } else {
      renderProviderPicker();
    }
  } catch (e) {
    root.innerHTML = `<div style="padding:24px;color:#ef4444;font-size:13px">
      Failed to load: ${e.message}
    </div>`;
  }
})();
