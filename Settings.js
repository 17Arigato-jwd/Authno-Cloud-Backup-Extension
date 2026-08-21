import { API } from './pageApi.js';

/**
 * Settings.js — cloud-backup extension UI — v2.0.0
 *
 * The v2 port of this file is almost entirely at the top: `API` is imported
 * from pageApi.js rather than read off `window.CloudBackupAPI`, and the four
 * places that handled credentials now name an operation instead. The rendering
 * below is unchanged, which is the point — a page that only asks for things
 * did not have to be rewritten to ask a different way.
 *
 * Two behaviours changed on purpose:
 *
 *   - **The .extbk import corner button is gone.** It listed .extbk files,
 *     downloaded the one you tapped, called `API.importExtension?.(base64)` —
 *     a method that has never existed on any version of this API — and then
 *     showed "✓ Done". So it downloaded a file, discarded it, and reported
 *     success. There is no v2 capability for an extension to install another
 *     extension, and there should not be: that is the one grant from which
 *     every other grant follows.
 *
 *   - **Connecting to WebDAV can now report "in a moment".** Granting a new
 *     origin cannot re-policy a document that has already loaded, so the app
 *     restarts the extension and the page says so rather than showing an
 *     error for a connection that is about to work.
 *
 * Changes from v1.3.2 (kept for the history):
 *   - Google Drive connected view replaced with a bespoke layout:
 *       • Frosted-glass header with gradient status circle (dark→light green)
 *       • Semi-transparent frosted-glass book-list with green iOS-style toggles
 *       • Upload icon shown next to books that are currently in the upload queue
 *       • Compact export card with inline green EXPORT pill button
 *       • Amber "Import from Cloud" button that expands an inline file picker
 *         (replaces the old navigate-to-cloud-files approach for Google Drive)
 *       • Blue "Sync Now" + red "Disconnect" bottom row
 *       • Progress bar that slides up from beneath the buttons on sync
 *   - Dropbox / WebDAV connected views remain completely unchanged
 *     (still use renderConnectedView()).
 *   - Init routing: activeProvider === 'gdrive' → renderGDriveView(),
 *     all other connected providers → renderConnectedView() as before.
 *   - Added esc() utility (was missing in Settings.js, only in CloudFilePicker).
 */

const PROVIDERS = [
  {
    key: 'gdrive', label: 'Google Drive', oAuth: true,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="22" height="22">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>`,
  },
  {
    key: 'dropbox', label: 'Dropbox', oAuth: true,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="22" height="22">
      <path fill="#0061FF" d="M10 2.5L0 9.167l10 6.666 10-6.666zM30 2.5l-10 6.667 10 6.666 10-6.666zM0 22.5l10 6.667 10-6.667-10-6.666zM30 15.834l-10 6.666 10 6.667 10-6.667zM10 30.833L20 37.5l10-6.667-10-6.666z"/>
    </svg>`,
  },
  {
    key: 'webdav', label: 'WebDAV / Self-hosted', oAuth: false,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
    </svg>`,
  },
];

document.head.insertAdjacentHTML('beforeend', `<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px; color: var(--text-1); background: transparent; min-height: 100vh; }

  /* ── Shared top progress bar ──────────────────────────────────────────────── */
  .progress-bar-wrap {
    position: sticky; top: 0; z-index: 10; height: 3px;
    background: var(--border); overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%; background: var(--accent);
    transition: width .4s ease, opacity .3s ease;
  }
  .progress-label {
    font-size: 10px; color: var(--text-4); text-align: center;
    padding: 3px 0; background: var(--surface-md); letter-spacing: .03em;
  }

  /* ── Provider picker ──────────────────────────────────────────────────────── */
  .login-screen { display: flex; flex-direction: column; align-items: center;
    justify-content: center; min-height: 100vh; padding: 32px 24px; }
  .login-title { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .login-sub { color: var(--text-3); font-size: 13px; margin-bottom: 32px;
    text-align: center; max-width: 300px; line-height: 1.5; }
  .login-sub strong { color: var(--text-1); }
  .section-label { font-size: 12px; font-weight: 600; color: var(--text-3);
    letter-spacing: .6px; text-transform: uppercase; margin-bottom: 14px;
    align-self: flex-start; max-width: 360px; width: 100%; }
  .pill-btn { display: flex; align-items: center; gap: 14px; width: 100%; max-width: 360px;
    padding: 14px 20px; border-radius: 999px; border: 1.5px solid var(--border);
    background: var(--surface); color: var(--text-1); cursor: pointer; font-size: 15px; font-weight: 500;
    margin-bottom: 12px; transition: border-color .15s, background .15s, transform .1s;
    text-align: left; -webkit-tap-highlight-color: transparent; }
  .pill-btn:hover  { border-color: var(--accent); background: var(--surface-md); }
  .pill-btn:active { transform: scale(0.98); }
  .pill-icon { width: 32px; height: 32px; border-radius: 50%; background: var(--surface-md);
    display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .pill-label { flex: 1; }
  .pill-chevron { color: var(--text-5); font-size: 16px; }

  /* ── Generic connected page (Dropbox / WebDAV) ────────────────────────────── */
  .page { padding: 16px; max-width: 480px; margin: 0 auto; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .sub { color: var(--text-4); font-size: 13px; margin-bottom: 20px; line-height: 1.5; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px; margin-bottom: 12px; }
  .card h2 { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: var(--text-4); margin-bottom: 4px; }
  .field input, .field select { width: 100%; background: var(--input-bg); border: 1px solid var(--border);
    color: var(--text-1); border-radius: 6px; padding: 8px 10px; font-size: 13px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 9px 16px; border-radius: 8px; border: none; cursor: pointer;
    font-size: 13px; font-weight: 500; }
  .btn-primary { background: var(--accent); color: var(--on-accent, #fff); }
  .btn-ghost   { background: var(--surface); border: 1px solid var(--border); color: var(--text-1); }
  .btn-danger  { background: var(--color-danger-bg); border: 1px solid var(--ds-danger-line); color: var(--color-danger); }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot-synced  { background: var(--color-success); }
  .dot-syncing { background: var(--color-warning); animation: pulse 1s ease-in-out infinite; }
  .dot-error   { background: var(--color-danger); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .err-banner { color: var(--color-danger); font-size: 12px; margin-top: 10px; padding: 8px 12px;
    background: var(--color-danger-bg); border-radius: 6px; border: 1px solid var(--ds-danger-line); }
  .hidden { display: none !important; }
  .toggle-row { display: flex; align-items: center; justify-content: space-between;
    padding: 8px 0; border-bottom: 1px solid var(--border); }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-label { font-size: 13px; }
  .toggle-sub { font-size: 11px; color: var(--text-4); margin-top: 1px; }
  .toggle { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; inset: 0; background: var(--border); border-radius: 11px;
    transition: background .2s; }
  .toggle input:checked + .toggle-slider { background: var(--accent); }
  .toggle-slider::after { content: ''; position: absolute; width: 16px; height: 16px;
    background: var(--on-accent, #fff); border-radius: 50%; top: 3px; left: 3px; transition: transform .2s; }
  .toggle input:checked + .toggle-slider::after { transform: translateX(16px); }
  .queue-row { display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .queue-row:last-child { border-bottom: none; }
  .error-msg { color: var(--color-danger); font-size: 11px; margin-top: 2px; }

  /* ══════════════════════════════════════════════════════════════════════════
     GOOGLE DRIVE BESPOKE UI
     ══════════════════════════════════════════════════════════════════════════ */

  /* Shared frosted-glass tile */
  .gd-tile {
    background: var(--glass-bg);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border: 1px solid var(--glass-border);
    border-radius: 14px;
  }

  .gd-screen {
    padding: 14px 14px 24px;
    max-width: 400px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    position: relative;
  }

  /* ① Header */
  .gd-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
  }
  .gd-provider-info {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .gd-provider-name { font-size: 14px; font-weight: 600; color: var(--text-1); }
  .gd-provider-sub  { font-size: 11px; color: var(--text-3); margin-top: 2px; }

  /* Gradient circle: dark green at left → bright green at right */
  .gd-status-circle {
    width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
    background: radial-gradient(circle at 28% 50%, var(--color-success-bg) 0%, var(--color-success) 100%);
    box-shadow: 0 0 10px var(--color-success-bg);
  }
  .gd-status-circle.syncing {
    background: conic-gradient(var(--color-success-bg) 0%, var(--color-success) 40%, var(--color-warning) 70%, var(--color-warning-bg) 100%);
    box-shadow: 0 0 10px var(--color-warning-bg);
    animation: gdSpin 1.1s linear infinite;
  }
  @keyframes gdSpin { to { transform: rotate(360deg); } }
  .gd-status-circle.error {
    background: radial-gradient(circle at 28% 50%, var(--color-danger-bg) 0%, var(--color-danger) 100%);
    box-shadow: 0 0 10px var(--color-danger-bg);
  }

  /* ② Book list */
  .gd-book-list {
    padding: 4px 12px;
    display: flex;
    flex-direction: column;
    max-height: 220px;
    overflow-y: auto;
  }
  .gd-book-list::-webkit-scrollbar        { width: 3px; }
  .gd-book-list::-webkit-scrollbar-track  { background: transparent; }
  .gd-book-list::-webkit-scrollbar-thumb  { background: var(--ds-tint); border-radius: 2px; }

  .gd-book-row {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 0;
    border-bottom: 1px solid var(--ds-tint-subtle);
  }
  .gd-book-row:last-child { border-bottom: none; }
  .gd-upload-icon { width: 20px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .gd-book-title  { flex: 1; font-size: 13px; color: var(--text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gd-no-books    { color: var(--text-5); font-size: 12px; padding: 16px 0; text-align: center; }

  /* Green iOS-style toggle */
  .gd-toggle { position: relative; width: 44px; height: 24px; flex-shrink: 0; cursor: pointer; }
  .gd-toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
  .gd-toggle-slider {
    position: absolute; inset: 0; border-radius: 12px;
    background: var(--surface-md); transition: background .2s; cursor: pointer;
  }
  .gd-toggle input:checked + .gd-toggle-slider { background: var(--color-success); }
  .gd-toggle-slider::after {
    content: ''; position: absolute; width: 18px; height: 18px;
    background: var(--on-accent, #fff); border-radius: 50%; top: 3px; left: 3px;
    transition: transform .2s; box-shadow: 0 1px 4px var(--scrim);
  }
  .gd-toggle input:checked + .gd-toggle-slider::after { transform: translateX(20px); }

  /* ③ Export card */
  .gd-export-card { padding: 13px 14px; }
  .gd-export-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .gd-export-label { font-size: 13px; font-weight: 600; color: var(--text-1); }
  .gd-export-btn {
    display: flex; align-items: center; gap: 5px;
    background: var(--color-success); color: var(--on-success);
    border: 1px solid var(--color-success); border-radius: 20px;
    padding: 5px 13px; font-size: 11px; font-weight: 700;
    letter-spacing: .06em; cursor: pointer; transition: background .15s;
    white-space: nowrap;
  }
  .gd-export-btn:hover    { background: var(--color-success-bg); }
  .gd-export-btn:disabled { opacity: .5; cursor: not-allowed; }

  .gd-field { margin-bottom: 9px; }
  .gd-field label { font-size: 11px; color: var(--text-4); display: block; margin-bottom: 4px; }
  .gd-field select,
  .gd-field input {
    width: 100%; background: var(--text-1); color: var(--on-accent);
    border: none; border-radius: 7px; padding: 7px 10px; font-size: 13px;
    appearance: none; -webkit-appearance: none;
  }
  .gd-field select {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23555'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 10px center;
    padding-right: 28px;
  }
  #gd-export-msg { font-size: 12px; margin-top: 6px; min-height: 16px; }

  /* ④ Amber import button */
  .gd-btn-import {
    width: 100%; padding: 12px 16px;
    background: linear-gradient(90deg, var(--color-warning), var(--color-warning));
    color: var(--on-accent, #fff); font-size: 14px; font-weight: 700;
    border: none; border-radius: 12px; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: filter .15s;
  }
  .gd-btn-import:hover { filter: brightness(1.08); }

  /* ⑤ Inline import file picker */
  .gd-import-panel {
    border: 2px solid var(--color-warning);
    border-radius: 14px;
    background: var(--app-bg);
    min-height: 115px;
    max-height: 200px;
    overflow-y: auto;
    padding: 10px 12px;
    animation: gdExpand .2s ease;
  }
  @keyframes gdExpand {
    from { opacity: 0; transform: translateY(-5px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .gd-import-placeholder {
    display: flex; align-items: center; justify-content: center;
    height: 80px;
    color: var(--text-5); font-size: 13px; font-weight: 600;
    transform: rotate(-14deg); pointer-events: none; user-select: none;
  }
  .gd-import-file {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 4px; border-bottom: 1px solid var(--ds-tint-subtle);
    cursor: pointer; border-radius: 6px; transition: background .1s;
    -webkit-tap-highlight-color: transparent;
  }
  .gd-import-file:last-child { border-bottom: none; }
  .gd-import-file:hover  { background: var(--ds-tint-subtle); }
  .gd-import-fname {
    flex: 1; font-size: 12px; color: var(--text-1);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .gd-badge-on-device {
    font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 5px;
    background: var(--color-success-bg); color: var(--color-success); white-space: nowrap; flex-shrink: 0;
  }
  .gd-badge-import {
    font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 5px;
    background: var(--accent-a18); color: var(--accent-light); white-space: nowrap; flex-shrink: 0;
  }
  .gd-import-state { text-align: center; padding: 22px 0; font-size: 12px; color: var(--text-5); }
  .gd-import-error { color: var(--color-danger); font-size: 12px; padding: 10px 0; }

  /* ⑥ Bottom row */
  .gd-bottom-row { display: flex; gap: 8px; }
  .gd-btn-sync {
    flex: 1; padding: 11px 0;
    background: var(--color-info); color: var(--on-accent, #fff);
    border: none; border-radius: 12px;
    font-size: 13px; font-weight: 700; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: filter .15s;
  }
  .gd-btn-sync:hover    { filter: brightness(1.12); }
  .gd-btn-sync:disabled { opacity: .55; cursor: not-allowed; filter: none; }
  .gd-btn-disconnect {
    flex: 1; padding: 11px 0;
    background: var(--color-danger); color: var(--on-accent, #fff);
    border: none; border-radius: 12px;
    font-size: 13px; font-weight: 700; cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: filter .15s;
  }
  .gd-btn-disconnect:hover { filter: brightness(1.12); }

  /* ⑦ Sync progress bar — slides up from beneath the bottom row */
  .gd-sync-progress-wrap {
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition: max-height .3s cubic-bezier(.4,0,.2,1), opacity .25s ease;
  }
  .gd-sync-progress-wrap.visible {
    max-height: 34px;
    opacity: 1;
  }
  .gd-sync-progress-inner {
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    border-radius: 8px;
    height: 26px;
    margin-top: 2px;
    overflow: hidden;
    position: relative;
  }
  .gd-sync-bar {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, var(--color-info), var(--accent), var(--accent-light));
    border-radius: 8px;
    transition: width .4s ease;
  }
  .gd-sync-label {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 600; color: var(--text-3);
    letter-spacing: .04em; pointer-events: none;
  }

`);

// One import replaces the global. See pageApi.js for which calls go straight
// to the host and which go through the background half, and why.
function getAPI() { return API; }

// ── HTML escape utility ───────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Shared top progress bar ───────────────────────────────────────────────────

const progressWrap = document.createElement('div');
progressWrap.className = 'progress-bar-wrap';
progressWrap.innerHTML = `<div class="progress-bar-fill" id="pb" style="width:0;opacity:0"></div>`;
document.body.appendChild(progressWrap);

const progressLabel = document.createElement('div');
progressLabel.className = 'progress-label';
progressLabel.id = 'pl';
progressLabel.style.display = 'none';
document.body.appendChild(progressLabel);

let _progressPoll = null;

function startProgressPoll() {
  if (_progressPoll) return;
  _progressPoll = setInterval(async () => {
    try {
      const event = await API.storage.getJSON('syncProgress', null);
      if (event) updateProgressBar(event);
    } catch {}
  }, 1500);
}

function stopProgressPoll() {
  if (_progressPoll) { clearInterval(_progressPoll); _progressPoll = null; }
}

function updateProgressBar(ev) {
  const pb = document.getElementById('pb');
  const pl = document.getElementById('pl');
  if (!pb || !pl) return;
  if (ev.phase === 'done' || ev.phase === 'offline') {
    pb.style.opacity = '0'; pl.style.display = 'none'; return;
  }
  const pct = ev.total > 0 ? Math.round((ev.current / ev.total) * 100) : 30;
  pb.style.width = pct + '%'; pb.style.opacity = '1'; pl.style.display = 'block';
  const phaseText = {
    checking:    `Checking ${ev.sessionTitle ?? ''}…`,
    downloading: `Downloading ${ev.sessionTitle ?? ''}…`,
    error:       `Error: ${ev.error ?? 'sync failed'}`,
  };
  pl.textContent = phaseText[ev.phase] ?? ev.phase;
  pb.style.background = ev.phase === 'error' ? '#ef4444' : '#6366f1';
}

// ── Root container ────────────────────────────────────────────────────────────
const root = document.createElement('div');
root.id = 'app';
document.body.appendChild(root);

// ═════════════════════════════════════════════════════════════════════════════
//  PROVIDER PICKER
// ═════════════════════════════════════════════════════════════════════════════

function renderProviderPicker() {
  stopProgressPoll();
  const pillsHtml = PROVIDERS.map(p => `
    <button class="pill-btn" data-key="${p.key}">
      <span class="pill-icon">${p.svg}</span>
      <span class="pill-label">Sign in with ${p.label}</span>
      <span class="pill-chevron">›</span>
    </button>`).join('');

  root.innerHTML = `<div class="login-screen">
    <div style="font-size:32px;margin-bottom:12px">☁️</div>
    <div class="login-title">Cloud Backup</div>
    <p class="login-sub">Choose a provider to back up your books.<br>
      Files will be saved in a folder named <strong>AuthNo</strong>.</p>
    <div class="section-label">Log in with</div>
    ${pillsHtml}
  </div>`;

  root.querySelectorAll('.pill-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = PROVIDERS.find(p => p.key === btn.dataset.key);
      if (!p) return;
      p.oAuth ? renderOAuthConnect(p.key) : renderWebDAVForm();
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  WEBDAV FORM
// ═════════════════════════════════════════════════════════════════════════════

function renderWebDAVForm() {
  root.innerHTML = `<div class="page">
    <h1>🖥️ WebDAV Setup</h1>
    <p class="sub">Connect to Nextcloud, ownCloud, Seafile, or any WebDAV server.</p>
    <div class="card">
      <div class="field"><label>Server URL</label>
        <input id="wdav-url" type="url" placeholder="https://cloud.example.com/remote.php/dav/files/user/"></div>
      <div class="field"><label>Auth type</label>
        <select id="wdav-auth">
          <option value="basic">Username + password</option>
          <option value="token">Bearer token</option>
        </select></div>
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
    const tok = e.target.value === 'token';
    document.getElementById('basic-fields').classList.toggle('hidden', tok);
    document.getElementById('token-field').classList.toggle('hidden', !tok);
  });
  document.getElementById('wdav-back').addEventListener('click', renderProviderPicker);
  document.getElementById('wdav-connect').addEventListener('click', async () => {
    const authType = document.getElementById('wdav-auth').value;
    const config = {
      baseUrl:  document.getElementById('wdav-url').value.trim(),
      authType,
      username: document.getElementById('wdav-user')?.value ?? '',
      password: document.getElementById('wdav-pass')?.value ?? '',
      token:    document.getElementById('wdav-token')?.value ?? '',
    };
    const btn = document.getElementById('wdav-connect');
    const err = document.getElementById('wdav-err');
    btn.textContent = 'Connecting…'; btn.disabled = true; err.textContent = '';
    try {
      await getAPI().connectProvider('webdav', config);
      await renderConnectedView();
    } catch (e) {
      err.className = 'err-banner'; err.textContent = e.message;
      btn.textContent = 'Connect'; btn.disabled = false;
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  OAUTH CONNECT (shared — routes to correct view on success)
// ═════════════════════════════════════════════════════════════════════════════

function renderOAuthConnect(providerKey) {
  const p = PROVIDERS.find(p => p.key === providerKey);
  const isNativeAuth = providerKey === 'gdrive';

  const subText = isNativeAuth
    ? `Sign in with your Google account to authorise Authno.<br>
       Files will be saved in a folder named <strong>AuthNo</strong> — nothing else is accessed.`
    : `You'll be taken to ${p.label} to authorise Authno.<br>
       Files will be saved in a folder named <strong>AuthNo</strong> — nothing else is accessed.`;

  root.innerHTML = `<div class="page">
    <h1>${p.label}</h1>
    <p class="sub">${subText}</p>
    <div style="display:flex;gap:10px;margin-top:8px">
      <button class="btn btn-primary" id="oauth-go">Connect with ${p.label}</button>
      <button class="btn btn-ghost" id="oauth-back">Cancel</button>
    </div>
    <div id="oauth-err"></div>
  </div>`;

  document.getElementById('oauth-back').addEventListener('click', renderProviderPicker);
  document.getElementById('oauth-go').addEventListener('click', async () => {
    const btn = document.getElementById('oauth-go');
    btn.textContent = isNativeAuth ? 'Signing in…' : 'Opening browser…';
    btn.disabled = true;
    try {
      await getAPI().connectProvider(providerKey, {});
      // Route: Google Drive gets the new view; everything else gets the old one
      if (providerKey === 'gdrive') await renderGDriveView();
      else await renderConnectedView();
    } catch (e) {
      const errEl = document.getElementById('oauth-err');
      if (errEl) { errEl.className = 'err-banner'; errEl.textContent = e.message; }
      btn.textContent = `Connect with ${p.label}`; btn.disabled = false;
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  DROPBOX / WEBDAV CONNECTED VIEW  (unchanged from v1.3.2)
// ═════════════════════════════════════════════════════════════════════════════

async function renderConnectedView() {
  const API = getAPI();
  const { activeProvider, tileStatus, queueEntries } = await API.getStatus();
  const p = PROVIDERS.find(p => p.key === activeProvider) ?? { label: activeProvider ?? 'Cloud', svg: '☁️' };
  const dotClass = `dot-${tileStatus}`;
  const sessions = (await API.getSessions()) ?? [];

  root.innerHTML = `<div class="page" style="position:relative">


    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px">
          <span>${p.svg ?? ''}</span>
          <div>
            <div style="font-weight:600">${p.label}</div>
            <div style="font-size:12px;color:var(--text-4);margin-top:2px">
              <span class="status-dot ${dotClass}"></span>
              ${tileStatus === 'synced'  ? 'All books backed up' :
                tileStatus === 'syncing' ? 'Syncing…' : 'Sync error — tap Sync now to retry'}
            </div>
          </div>
        </div>
        <button class="btn btn-ghost" id="btn-disconnect" style="font-size:12px;padding:6px 12px">Disconnect</button>
      </div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn btn-primary" id="btn-sync-now" style="flex:1">↻ Sync now</button>
        <button class="btn btn-ghost" id="btn-import" style="flex:1">☁️ Import from cloud</button>
      </div>
    </div>

    ${queueEntries.length > 0 ? `
    <div class="card">
      <h2>Upload queue (${queueEntries.length})</h2>
      ${queueEntries.map(e => `
        <div class="queue-row">
          <div>
            <div>${e.title}</div>
            ${e.errorMsg ? `<div class="error-msg">${e.errorMsg}</div>` : ''}
          </div>
          <span style="color:var(--text-4);font-size:11px">${e.attempts}/5</span>
        </div>`).join('')}
    </div>` : ''}

    <div class="card">
      <h2>Export to cloud</h2>
      <div id="export-session-picker">
        <div class="field"><label>Book</label>
          <select id="export-session">
            ${sessions.map(s => `<option value="${s.id}">${s.title || 'Untitled'}</option>`).join('')}
          </select></div>
        <div class="field"><label>Format</label>
          <select id="export-format">
            <option value="txt">Plain text (.txt)</option>
            <option value="html">HTML (.html)</option>
            <option value="epub">EPUB (.epub)</option>
          </select></div>
        <button class="btn btn-primary" id="btn-export" style="width:100%">Export to ${p.label}</button>
        <div id="export-msg" style="margin-top:8px;font-size:12px"></div>
      </div>
    </div>

    <div class="card">
      <h2>Per-book backup</h2>
      <div id="book-toggles">Loading…</div>
    </div>

    <p style="color:var(--text-4);font-size:11px;margin-top:8px">
      Books back up automatically after every auto-save.
    </p>
  </div>`;

  startProgressPoll();


  document.getElementById('btn-disconnect')?.addEventListener('click', async () => {
    stopProgressPoll();
    await API.disconnectProvider();
    renderProviderPicker();
  });

  document.getElementById('btn-sync-now')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-sync-now');
    btn.textContent = 'Syncing…'; btn.disabled = true;
    try { await API.syncNow(); } catch (e) { console.error('[cloud-backup] syncNow error:', e); }
    finally { btn.textContent = '↻ Sync now'; btn.disabled = false; await renderConnectedView(); }
  });

  document.getElementById('btn-import')?.addEventListener('click', () => {
    // (pageId, session) — v1's navigate took the extension object first,
    // because the host had to be told which extension was asking. In v2 the
    // frame IS the extension, so the host already knows.
    API.navigate('cloud-files', null);
  });

  document.getElementById('btn-export')?.addEventListener('click', async () => {
    const sessionId = document.getElementById('export-session').value;
    const format    = document.getElementById('export-format').value;
    const msg       = document.getElementById('export-msg');
    const btn       = document.getElementById('btn-export');
    btn.textContent = 'Exporting…'; btn.disabled = true; msg.textContent = '';
    try {
      // One operation. v1 read the credentials into this page, exported the
      // book here, and uploaded from here — three steps, and an access token
      // in the settings frame for something the background half does whole.
      const { filename: fname } = await API.exportToCloud(sessionId, format);
      msg.style.color = '#22c55e'; msg.textContent = `✓ Exported ${fname} to ${p.label}`;
    } catch (e) {
      msg.style.color = '#ef4444'; msg.textContent = e.message;
    } finally {
      btn.textContent = `Export to ${p.label}`; btn.disabled = false;
    }
  });

  const togglesEl = document.getElementById('book-toggles');
  if (togglesEl) {
    if (!sessions.length) {
      togglesEl.innerHTML = '<div style="color:var(--text-4);font-size:12px">No books yet.</div>';
    } else {
      const rows = await Promise.all(sessions.map(async s => {
        const disabled = await API.isBookBackupDisabled(s.id);
        return { id: s.id, title: s.title || 'Untitled', disabled };
      }));
      togglesEl.innerHTML = rows.map(r => `
        <div class="toggle-row">
          <div>
            <div class="toggle-label">${r.title}</div>
            <div class="toggle-sub">${r.disabled ? 'Not backed up' : 'Auto-backup on'}</div>
          </div>
          <label class="toggle" title="Toggle backup for this book">
            <input type="checkbox" ${r.disabled ? '' : 'checked'}
              onchange="toggleBook('${r.id}', !this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>`).join('');
    }
  }

  window.toggleBook = async (sessionId, disable) => {
    await API.setBookBackupDisabled(sessionId, disable);
    const row = document.querySelector(`[onchange*="${sessionId}"]`)?.closest('.toggle-row');
    if (row) row.querySelector('.toggle-sub').textContent = disable ? 'Not backed up' : 'Auto-backup on';
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  GOOGLE DRIVE — BESPOKE CONNECTED VIEW
// ═════════════════════════════════════════════════════════════════════════════

async function renderGDriveView() {
  const API = getAPI();
  const { activeProvider, tileStatus, queueEntries } = await API.getStatus();
  const sessions = (await API.getSessions()) ?? [];

  // Books with queue and toggle state
  const queueIds = new Set((queueEntries ?? []).map(e => e.sessionId));
  const bookData = await Promise.all(sessions.map(async s => ({
    id:      s.id,
    title:   s.title || 'Untitled',
    disabled: await API.isBookBackupDisabled(s.id),
    queued:  queueIds.has(s.id),
  })));

  const circleClass = tileStatus === 'syncing' ? 'syncing'
                    : tileStatus === 'error'   ? 'error'
                    : '';
  const statusText  = tileStatus === 'synced'  ? 'All Selected Books Backed Up'
                    : tileStatus === 'syncing' ? 'Syncing…'
                    : 'Sync Error — tap Sync Now to retry';

  // SVGs defined inline so no external dependencies
  const uploadSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15"
    viewBox="0 0 24 24" fill="none" stroke="#8888bb" stroke-width="2.2"
    stroke-linecap="round" stroke-linejoin="round">
    <polyline points="16 16 12 12 8 16"/>
    <line x1="12" y1="12" x2="12" y2="21"/>
    <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
  </svg>`;

  const leafSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/>
    <path d="M2 21c0-3 1.85-5.36 5.08-6 3.23-.64 6.8-2 9.2-5.09"/>
  </svg>`;

  const gDriveSVG = PROVIDERS.find(p => p.key === 'gdrive')?.svg ?? '';

  const bookRowsHtml = bookData.length === 0
    ? `<div class="gd-no-books">No books yet.</div>`
    : bookData.map(b => `
        <div class="gd-book-row">
          <span class="gd-upload-icon">${b.queued ? uploadSVG : ''}</span>
          <span class="gd-book-title">${esc(b.title)}</span>
          <label class="gd-toggle" title="${b.disabled ? 'Backup off' : 'Backup on'}">
            <input type="checkbox" ${b.disabled ? '' : 'checked'}
              onchange="gdToggleBook('${esc(b.id)}', !this.checked)">
            <span class="gd-toggle-slider"></span>
          </label>
        </div>`).join('');

  root.innerHTML = `<div class="gd-screen">


    <!-- ① Header -->
    <div class="gd-tile gd-header">
      <div class="gd-provider-info">
        ${gDriveSVG}
        <div>
          <div class="gd-provider-name">Google Drive</div>
          <div class="gd-provider-sub">${esc(statusText)}</div>
        </div>
      </div>
      <div class="gd-status-circle ${circleClass}"></div>
    </div>

    <!-- ② Book list (frosted glass, scrollable) -->
    <div class="gd-tile gd-book-list">
      ${bookRowsHtml}
    </div>

    <!-- ③ Export card -->
    <div class="gd-tile gd-export-card">
      <div class="gd-export-header">
        <span class="gd-export-label">Export to Cloud</span>
        <button class="gd-export-btn" id="gd-btn-export">
          ${leafSVG} EXPORT
        </button>
      </div>
      <div class="gd-field">
        <label>Book</label>
        <select id="gd-export-session">
          ${sessions.length
            ? sessions.map(s => `<option value="${esc(s.id)}">${esc(s.title || 'Untitled')}</option>`).join('')
            : `<option disabled selected>No books</option>`}
        </select>
      </div>
      <div class="gd-field">
        <label>Format</label>
        <select id="gd-export-format">
          <option value="txt">Plain text (.txt)</option>
          <option value="html">HTML (.html)</option>
          <option value="epub">EPUB (.epub)</option>
        </select>
      </div>
      <div id="gd-export-msg"></div>
    </div>

    <!-- ④ Import button -->
    <button class="gd-btn-import" id="gd-btn-import">Import from Cloud</button>

    <!-- ⑤ Inline file picker (toggled by the button above) -->
    <div class="gd-import-panel hidden" id="gd-import-panel">
      <div class="gd-import-placeholder">Files and Folders in Cloud</div>
    </div>

    <!-- ⑥ Sync / Disconnect -->
    <div class="gd-bottom-row">
      <button class="gd-btn-sync" id="gd-btn-sync">Sync Now</button>
      <button class="gd-btn-disconnect" id="gd-btn-disconnect">Disconnect</button>
    </div>

    <!-- ⑦ Progress bar — slides up from beneath the buttons -->
    <div class="gd-sync-progress-wrap" id="gd-sync-progress-wrap">
      <div class="gd-sync-progress-inner">
        <div class="gd-sync-bar" id="gd-sync-bar"></div>
        <div class="gd-sync-label" id="gd-sync-label">Syncing…</div>
      </div>
    </div>

  </div>`;

  startProgressPoll();


  // ── Disconnect ────────────────────────────────────────────────────────────
  document.getElementById('gd-btn-disconnect')?.addEventListener('click', async () => {
    stopProgressPoll();
    await API.disconnectProvider();
    renderProviderPicker();
  });

  // ── Sync Now ──────────────────────────────────────────────────────────────
  document.getElementById('gd-btn-sync')?.addEventListener('click', async () => {
    const btn  = document.getElementById('gd-btn-sync');
    const wrap = document.getElementById('gd-sync-progress-wrap');
    const bar  = document.getElementById('gd-sync-bar');
    const lbl  = document.getElementById('gd-sync-label');

    btn.textContent = 'Syncing…';
    btn.disabled    = true;
    wrap?.classList.add('visible');

    // Fake-advance bar to 85% while the real sync runs
    let pct = 0;
    const ticker = setInterval(() => {
      pct = Math.min(pct + 7, 85);
      if (bar) bar.style.width = pct + '%';
    }, 300);

    try {
      await API.syncNow();
      if (lbl) lbl.textContent = 'Sync complete ✓';
    } catch (e) {
      console.error('[cloud-backup] syncNow error:', e);
      if (lbl) lbl.textContent = 'Sync failed';
      if (bar) bar.style.background = '#ef4444';
    } finally {
      clearInterval(ticker);
      if (bar) bar.style.width = '100%';
      setTimeout(async () => {
        wrap?.classList.remove('visible');
        await renderGDriveView(); // re-render to pick up new tileStatus / queue
      }, 750);
    }
  });

  // ── Import from Cloud ─────────────────────────────────────────────────────
  document.getElementById('gd-btn-import')?.addEventListener('click', () => {
    const panel = document.getElementById('gd-import-panel');
    if (!panel) return;
    const isOpen = !panel.classList.contains('hidden');
    if (isOpen) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    _gdLoadImportPanel(panel);
  });

  // ── Export ────────────────────────────────────────────────────────────────
  document.getElementById('gd-btn-export')?.addEventListener('click', async () => {
    const sessionId = document.getElementById('gd-export-session')?.value;
    const format    = document.getElementById('gd-export-format')?.value ?? 'txt';
    const msg       = document.getElementById('gd-export-msg');
    const btn       = document.getElementById('gd-btn-export');
    if (!sessionId) return;

    btn.innerHTML = `${leafSVG} Exporting…`;
    btn.disabled  = true;
    if (msg) msg.textContent = '';

    try {
      // One operation. v1 read the credentials into this page, exported the
      // book here, and uploaded from here — three steps, and an access token
      // in the settings frame for something the background half does whole.
      const { filename: fname } = await API.exportToCloud(sessionId, format);
      if (msg) { msg.style.color = '#4ade80'; msg.textContent = `✓ Exported ${fname}`; }
    } catch (e) {
      if (msg) { msg.style.color = '#f87171'; msg.textContent = e.message; }
    } finally {
      btn.innerHTML = `${leafSVG} EXPORT`;
      btn.disabled  = false;
    }
  });

  // ── Per-book toggle (inline onchange) ────────────────────────────────────
  window.gdToggleBook = async (sessionId, disable) => {
    await API.setBookBackupDisabled(sessionId, disable);
  };
}

// ── Import panel: load real file list from Drive ──────────────────────────────

async function _gdLoadImportPanel(panel) {
  panel.innerHTML = `<div class="gd-import-state">Loading…</div>`;
  try {
    // The background half refreshes the token before it lists, so a page left
    // open for a while does not fail with "not authenticated".

    const files         = await API.listCloudFiles();
    const localSessions = (await API.getSessions()) ?? [];

    if (!files.length) {
      panel.innerHTML = `<div class="gd-import-state">No .authbook files found in your AuthNo folder.</div>`;
      return;
    }

    // Stash for gdImportFile path lookup
    panel._files = files;

    function fmtDate(iso) {
      if (!iso) return '';
      return new Date(iso).toLocaleDateString(undefined,
        { month: 'short', day: 'numeric', year: 'numeric' });
    }

    panel.innerHTML = files.map(f => {
      const onDevice    = localSessions.some(s => s.id === f.sessionId);
      const displayName = f.displayName || f.name.replace(/^authno_/, '').replace(/\.authbook$/, '') || f.name;
      const dateTxt     = fmtDate(f.modifiedTime);
      return `<div class="gd-import-file"
          data-sid="${esc(f.sessionId)}"
          onclick="gdImportFile('${esc(f.sessionId)}','${esc(displayName)}')">
        <span>📖</span>
        <span class="gd-import-fname">
          ${esc(displayName)}
          ${dateTxt ? `<span style="color:var(--text-5);font-size:10px;margin-left:5px">${esc(dateTxt)}</span>` : ''}
        </span>
        <span class="${onDevice ? 'gd-badge-on-device' : 'gd-badge-import'}">
          ${onDevice ? '✓ On device' : 'Import'}
        </span>
      </div>`;
    }).join('');
  } catch (e) {
    panel.innerHTML = `<div class="gd-import-error">${esc(e.message)}</div>`;
  }
}

// Global called from inline onclick in the file list
window.gdImportFile = async (sessionId, displayName) => {
  const API   = getAPI();
  const panel = document.getElementById('gd-import-panel');
  const row   = panel?.querySelector(`[data-sid="${CSS.escape(sessionId)}"]`);
  const badge = row?.querySelector('[class^="gd-badge"]');

  if (badge) badge.textContent = '…';

  try {
    // The provider's own path when the listing gave one. Dropbox stores under
    // `{Title}_{id}.authbook`, so an id rebuilt from the name misses any book
    // whose title changed since it was last uploaded.
    const fileEntry = (panel._files ?? []).find(f => f.sessionId === sessionId);
    await API.restoreFromCloud(fileEntry?.dropboxPath ?? sessionId);
    if (badge) { badge.className = 'gd-badge-on-device'; badge.textContent = '✓ On device'; }
  } catch (e) {
    console.error('[cloud-backup] gdImportFile failed:', e);
    if (badge) { badge.style.color = '#f87171'; badge.textContent = 'Failed'; }
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  INIT
// ═════════════════════════════════════════════════════════════════════════════

(async () => {
  try {
    const { activeProvider } = await getAPI().getStatus();
    if (activeProvider === 'gdrive') await renderGDriveView();
    else if (activeProvider)         await renderConnectedView();
    else                             renderProviderPicker();
  } catch (e) {
    document.body.innerHTML += `<div style="padding:24px;color:var(--color-danger);font-size:13px">
      Failed to load: ${esc(e.message)}</div>`;
  }
})();
