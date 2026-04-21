/**
 * CloudFilePicker.js — Feature B: browse and import cloud files — v1.2.3
 *
 * A full-screen file browser rendered inside the extension's iframe.
 * Accessible via: Settings.js → "Import from cloud" button.
 *
 * Flow:
 *   1. Lists all .authbook files in the AuthNo folder on the active provider.
 *   2. User taps a file → confirmation sheet.
 *   3. On confirm: download → AuthNoExtensionAPI.importSession(base64) → success toast.
 *
 * Sessions already in the app are marked with a "✓ On device" badge.
 * The latest version from cloud is always offered for import (overwrite local).
 */

const API = window.CloudBackupAPI;

// ── Styles ───────────────────────────────────────────────────────────────────

document.head.insertAdjacentHTML('beforeend', `<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px; color: #e4e4f0; background: transparent; min-height: 100vh; }

  .screen { padding: 20px 16px; max-width: 480px; margin: 0 auto; }
  h1 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
  .sub { color: #6b6b80; font-size: 12px; margin-bottom: 20px; line-height: 1.5; }

  .file-list { display: flex; flex-direction: column; gap: 8px; }
  .file-row {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 14px; background: #1f1f2a; border: 1px solid #2e2e3a;
    border-radius: 10px; cursor: pointer; transition: background .15s, border-color .15s;
    -webkit-tap-highlight-color: transparent;
  }
  .file-row:hover, .file-row:active { background: #2a2a38; border-color: #6366f144; }
  .file-icon { font-size: 22px; flex-shrink: 0; }
  .file-info { flex: 1; min-width: 0; }
  .file-name { font-size: 13px; font-weight: 600; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .file-meta { font-size: 11px; color: #6b6b80; margin-top: 2px; }
  .badge-local { font-size: 10px; font-weight: 600; padding: 1px 6px;
    background: #22c55e22; color: #4ade80; border-radius: 5px; }
  .badge-import { font-size: 10px; font-weight: 600; padding: 1px 6px;
    background: #6366f122; color: #818cf8; border-radius: 5px; }

  .empty { text-align: center; padding: 48px 24px; color: #6b6b80; font-size: 13px; }
  .err { color: #ef4444; font-size: 12px; padding: 12px; background: #ef444418;
    border-radius: 8px; margin-bottom: 12px; }

  .loading { text-align: center; padding: 40px; color: #6b6b80; font-size: 13px; }
  .spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #2e2e3a;
    border-top-color: #6366f1; border-radius: 50%; animation: spin .8s linear infinite; margin-bottom: 8px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .sheet-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6);
    display: flex; align-items: flex-end; z-index: 100; }
  .sheet { background: #1a1a24; border-radius: 16px 16px 0 0; padding: 20px 20px 32px;
    width: 100%; border-top: 1px solid #2e2e3a; }
  .sheet h2 { font-size: 16px; font-weight: 700; margin-bottom: 4px; }
  .sheet-sub { color: #6b6b80; font-size: 12px; margin-bottom: 20px; }
  .btn { display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 12px; border-radius: 10px; border: none; cursor: pointer;
    font-size: 14px; font-weight: 600; width: 100%; margin-bottom: 8px; }
  .btn-primary { background: #6366f1; color: #fff; }
  .btn-ghost { background: #1f1f2a; border: 1px solid #2e2e3a; color: #e4e4f0; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .back-btn { display: flex; align-items: center; gap: 6px; background: none; border: none;
    color: #6b6b80; font-size: 13px; cursor: pointer; margin-bottom: 16px; padding: 0; }

  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: #22c55e; color: #fff; font-size: 13px; font-weight: 600;
    padding: 10px 20px; border-radius: 20px; z-index: 200;
    animation: fadeUp .25s ease; }
  @keyframes fadeUp { from { opacity: 0; transform: translateX(-50%) translateY(8px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); } }
</style>`);

// ── State ─────────────────────────────────────────────────────────────────────

let files = [];
let localSessions = [];
let selectedFile = null;
let importing = false;

const root = document.body;

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  renderLoading();
  try {
    const { activeProvider } = await API.getStatus();
    if (!activeProvider) {
      root.innerHTML = `<div class="screen"><div class="err">No cloud provider connected. Connect one in Cloud Backup settings first.</div></div>`;
      return;
    }

    localSessions = (await API.getSessions()) ?? [];

    // Use refreshCreds so an expired token is silently refreshed and saved back
    // before we hit listFiles. This is the root cause of "import doesn't work"
    // when a session has been idle and the token has expired.
    const provider = API.providers[activeProvider];
    if (!provider?.listFiles) throw new Error('listFiles not supported by this provider');

    // Load creds via refreshCreds (saves refreshed token back to storage)
    const creds = await provider.refreshCreds(API.storage);
    if (!creds) throw new Error('Not authenticated');

    files = await provider.listFiles(creds);
    renderList();
  } catch (e) {
    root.innerHTML = `<div class="screen"><div class="err">${e.message}</div>
      <button class="btn btn-ghost" onclick="window.parent.postMessage({type:'ext-close'},'*')" style="margin-top:8px">← Back</button></div>`;
  }
})();

// ── Render helpers ────────────────────────────────────────────────────────────

function renderLoading() {
  root.innerHTML = `<div class="loading"><div class="spinner"></div><div>Loading files…</div></div>`;
}

function isOnDevice(sessionId) {
  return localSessions.some(s => s.id === sessionId);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderList() {
  if (!files.length) {
    root.innerHTML = `<div class="screen">
      <button class="back-btn" onclick="window.parent.postMessage({type:'ext-close'},'*')">← Back</button>
      <h1>☁️ Cloud Files</h1>
      <div class="empty">No .authbook files found in your AuthNo cloud folder.</div>
    </div>`;
    return;
  }

  const rows = files.map(f => {
    const onDevice = isOnDevice(f.sessionId);
    const label    = f.displayName || f.name.replace(/^authno_/, '').replace(/\.authbook$/, '') || f.name;
    return `<div class="file-row" onclick="selectFile('${f.sessionId}')">
      <div class="file-icon">📖</div>
      <div class="file-info">
        <div class="file-name">${esc(label)}</div>
        <div class="file-meta">${fmtDate(f.modifiedTime)}${f.size ? ' · ' + fmtBytes(f.size) : ''}</div>
      </div>
      <span class="${onDevice ? 'badge-local' : 'badge-import'}">${onDevice ? '✓ On device' : 'Import'}</span>
    </div>`;
  }).join('');

  root.innerHTML = `<div class="screen">
    <button class="back-btn" onclick="window.parent.postMessage({type:'ext-close'},'*')">← Back</button>
    <h1>☁️ Cloud Files</h1>
    <p class="sub">${files.length} file${files.length !== 1 ? 's' : ''} in your AuthNo cloud folder. Tap to import.</p>
    <div class="file-list">${rows}</div>
  </div>`;
}

function renderConfirmSheet() {
  const f = files.find(f => f.sessionId === selectedFile);
  if (!f) return;
  const onDevice    = isOnDevice(f.sessionId);
  const displayName = f.displayName || f.name.replace(/^authno_/, '').replace(/\.authbook$/, '') || f.name;

  const sheet = document.createElement('div');
  sheet.className = 'sheet-overlay';
  sheet.id = 'confirm-sheet';
  sheet.innerHTML = `<div class="sheet">
    <h2>${esc(displayName)}</h2>
    <p class="sheet-sub">${fmtDate(f.modifiedTime)}${f.size ? ' · ' + fmtBytes(f.size) : ''}
      ${onDevice ? ' · Will update existing local copy' : ' · Will be added to your library'}</p>
    <button class="btn btn-primary" id="btn-confirm" onclick="confirmImport()">
      ${onDevice ? 'Update from cloud' : 'Import to library'}
    </button>
    <button class="btn btn-ghost" onclick="dismissSheet()">Cancel</button>
    <div id="sheet-err" style="color:#ef4444;font-size:12px;margin-top:8px"></div>
  </div>`;
  document.body.appendChild(sheet);
}

async function confirmImport() {
  if (importing) return;
  importing = true;
  const btn = document.getElementById('btn-confirm');
  if (btn) { btn.textContent = 'Downloading…'; btn.disabled = true; }

  try {
    const { activeProvider } = await API.getStatus();
    const provider = API.providers[activeProvider];

    // Use refreshCreds so an expired token is refreshed and saved before download
    const creds = await provider.refreshCreds(API.storage);
    if (!creds) throw new Error('Not authenticated');

    // Pass the actual cloud path when available (fixes Dropbox import path mismatch)
    const f          = files.find(f => f.sessionId === selectedFile);
    const downloadId = f?.dropboxPath ?? selectedFile;
    const { base64 } = await provider.download(downloadId, creds);
    await API.importSession(base64);

    dismissSheet();
    showToast('✓ Imported successfully');
    // Refresh local sessions list
    localSessions = (await API.getSessions()) ?? [];
    renderList();
  } catch (e) {
    const errEl = document.getElementById('sheet-err');
    if (errEl) errEl.textContent = e.message;
    if (btn) { btn.textContent = 'Retry'; btn.disabled = false; }
  } finally {
    importing = false;
  }
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

// ── Global callbacks (called from inline onclick) ─────────────────────────────

window.selectFile = (sessionId) => {
  selectedFile = sessionId;
  renderConfirmSheet();
};

window.dismissSheet = () => {
  document.getElementById('confirm-sheet')?.remove();
  selectedFile = null;
};

window.confirmImport = confirmImport;

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
