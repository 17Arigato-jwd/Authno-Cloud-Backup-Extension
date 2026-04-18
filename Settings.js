/**
 * Settings.js — cloud-backup extension UI — v1.2.3
 *
 * New in v1.2.3:
 *   - Sync progress bar at top (polls storage.get('syncProgress') every 2s)
 *   - "Import from cloud" button → navigates to cloud-files page (Feature B)
 *   - Per-book backup toggle section (Feature C)
 *   - Export panel (Feature A): txt / html / epub export directly to cloud
 *   - "Sync now" button that triggers an immediate poll
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
    key: 'onedrive', label: 'OneDrive', oAuth: true,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21" width="22" height="22">
      <rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
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
    font-size: 14px; color: #e4e4f0; background: transparent; min-height: 100vh; }

  .progress-bar-wrap {
    position: sticky; top: 0; z-index: 10; height: 3px;
    background: #2e2e3a; overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%; background: #6366f1;
    transition: width .4s ease, opacity .3s ease;
  }
  .progress-label {
    font-size: 10px; color: #6b6b80; text-align: center;
    padding: 3px 0; background: #0f0f18; letter-spacing: .03em;
  }

  .login-screen { display: flex; flex-direction: column; align-items: center;
    justify-content: center; min-height: 100vh; padding: 32px 24px; }
  .login-title { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .login-sub { color: #9999aa; font-size: 13px; margin-bottom: 32px;
    text-align: center; max-width: 300px; line-height: 1.5; }
  .login-sub strong { color: #e4e4f0; }
  .section-label { font-size: 12px; font-weight: 600; color: #9999aa;
    letter-spacing: .6px; text-transform: uppercase; margin-bottom: 14px;
    align-self: flex-start; max-width: 360px; width: 100%; }
  .pill-btn { display: flex; align-items: center; gap: 14px; width: 100%; max-width: 360px;
    padding: 14px 20px; border-radius: 999px; border: 1.5px solid #3a3a4a;
    background: #1c1c26; color: #e4e4f0; cursor: pointer; font-size: 15px; font-weight: 500;
    margin-bottom: 12px; transition: border-color .15s, background .15s, transform .1s;
    text-align: left; -webkit-tap-highlight-color: transparent; }
  .pill-btn:hover  { border-color: #6366f1; background: #1f1f2e; }
  .pill-btn:active { transform: scale(0.98); }
  .pill-icon { width: 32px; height: 32px; border-radius: 50%; background: #111118;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .pill-label { flex: 1; }
  .pill-chevron { color: #4a4a5a; font-size: 16px; }

  .page { padding: 16px; max-width: 480px; margin: 0 auto; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .sub { color: #6b6b80; font-size: 13px; margin-bottom: 20px; line-height: 1.5; }
  .card { background: #1f1f2a; border: 1px solid #2e2e3a; border-radius: 12px;
    padding: 16px; margin-bottom: 12px; }
  .card h2 { font-size: 13px; font-weight: 600; margin-bottom: 12px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: #6b6b80; margin-bottom: 4px; }
  .field input, .field select { width: 100%; background: #16161d; border: 1px solid #2e2e3a;
    color: #e4e4f0; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    padding: 9px 16px; border-radius: 8px; border: none; cursor: pointer;
    font-size: 13px; font-weight: 500; }
  .btn-primary { background: #6366f1; color: #fff; }
  .btn-ghost   { background: #1f1f2a; border: 1px solid #2e2e3a; color: #e4e4f0; }
  .btn-danger  { background: #ef444418; border: 1px solid #ef444430; color: #fca5a5; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot-synced  { background: #22c55e; }
  .dot-syncing { background: #eab308; animation: pulse 1s ease-in-out infinite; }
  .dot-error   { background: #ef4444; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .err-banner { color: #ef4444; font-size: 12px; margin-top: 10px; padding: 8px 12px;
    background: #ef444418; border-radius: 6px; border: 1px solid #ef444430; }
  .hidden { display: none !important; }
  .toggle-row { display: flex; align-items: center; justify-content: space-between;
    padding: 8px 0; border-bottom: 1px solid #2e2e3a; }
  .toggle-row:last-child { border-bottom: none; }
  .toggle-label { font-size: 13px; }
  .toggle-sub { font-size: 11px; color: #6b6b80; margin-top: 1px; }
  .toggle { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider { position: absolute; inset: 0; background: #2e2e3a; border-radius: 11px;
    transition: background .2s; }
  .toggle input:checked + .toggle-slider { background: #6366f1; }
  .toggle-slider::after { content: ''; position: absolute; width: 16px; height: 16px;
    background: #fff; border-radius: 50%; top: 3px; left: 3px; transition: transform .2s; }
  .toggle input:checked + .toggle-slider::after { transform: translateX(16px); }
  .queue-row { display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0; border-bottom: 1px solid #2e2e3a; font-size: 12px; }
  .queue-row:last-child { border-bottom: none; }
  .error-msg { color: #ef4444; font-size: 11px; margin-top: 2px; }
</style>`);

function getAPI() { return window.CloudBackupAPI; }

// ── Progress bar ──────────────────────────────────────────────────────────────

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
      const raw = await getAPI().storage.get('syncProgress');
      if (!raw) return;
      const ev = JSON.parse(raw);
      updateProgressBar(ev);
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
    pb.style.opacity = '0';
    pl.style.display = 'none';
    return;
  }

  const pct = ev.total > 0 ? Math.round((ev.current / ev.total) * 100) : 30;
  pb.style.width  = pct + '%';
  pb.style.opacity = '1';
  pl.style.display = 'block';

  const phaseText = {
    checking:    `Checking ${ev.sessionTitle ?? ''}…`,
    downloading: `Downloading ${ev.sessionTitle ?? ''}…`,
    error:       `Error: ${ev.error ?? 'sync failed'}`,
  };
  pl.textContent = phaseText[ev.phase] ?? ev.phase;
  if (ev.phase === 'error') { pb.style.background = '#ef4444'; }
  else { pb.style.background = '#6366f1'; }
}

// ── Root container ────────────────────────────────────────────────────────────
const root = document.createElement('div');
root.id = 'app';
document.body.appendChild(root);

// ── Screens ───────────────────────────────────────────────────────────────────

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
    btn.textContent = 'Opening browser…'; btn.disabled = true;
    try {
      await getAPI().connectProvider(providerKey, {});
      await renderConnectedView();
    } catch (e) {
      const errEl = document.getElementById('oauth-err');
      if (errEl) { errEl.className = 'err-banner'; errEl.textContent = e.message; }
      btn.textContent = `Connect with ${p.label}`; btn.disabled = false;
    }
  });
}

async function renderConnectedView() {
  const API = getAPI();
  const { activeProvider, tileStatus, queueEntries } = await API.getStatus();
  const p = PROVIDERS.find(p => p.key === activeProvider) ?? { label: activeProvider ?? 'Cloud', svg: '☁️' };
  const dotClass = `dot-${tileStatus}`;

  const sessions = (await API.getSessions()) ?? [];

  root.innerHTML = `<div class="page">

    <!-- Status card -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px">
          <span>${p.svg ?? ''}</span>
          <div>
            <div style="font-weight:600">${p.label}</div>
            <div style="font-size:12px;color:#6b6b80;margin-top:2px">
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

    <!-- Upload queue -->
    ${queueEntries.length > 0 ? `
    <div class="card">
      <h2>Upload queue (${queueEntries.length})</h2>
      ${queueEntries.map(e => `
        <div class="queue-row">
          <div>
            <div>${e.title}</div>
            ${e.errorMsg ? `<div class="error-msg">${e.errorMsg}</div>` : ''}
          </div>
          <span style="color:#6b6b80;font-size:11px">${e.attempts}/5</span>
        </div>`).join('')}
    </div>` : ''}

    <!-- Feature A: Export to cloud -->
    <div class="card">
      <h2>Export to cloud</h2>
      <div id="export-session-picker">
        <div class="field"><label>Book</label>
          <select id="export-session">
            ${sessions.map(s => `<option value="${s.id}">${s.title || 'Untitled'}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Format</label>
          <select id="export-format">
            <option value="txt">Plain text (.txt)</option>
            <option value="html">HTML (.html)</option>
            <option value="epub">EPUB (.epub)</option>
          </select>
        </div>
        <button class="btn btn-primary" id="btn-export" style="width:100%">Export to ${p.label}</button>
        <div id="export-msg" style="margin-top:8px;font-size:12px"></div>
      </div>
    </div>

    <!-- Feature C: Per-book backup toggles -->
    <div class="card">
      <h2>Per-book backup</h2>
      <div id="book-toggles">Loading…</div>
    </div>

    <p style="color:#6b6b80;font-size:11px;margin-top:8px">
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
    await API.storage.set('syncProgress', JSON.stringify({ phase: 'checking', current: 0, total: sessions.length }));
    // Signal the extension background to poll immediately — it reads syncProgress
    setTimeout(async () => {
      btn.textContent = '↻ Sync now'; btn.disabled = false;
      await renderConnectedView();
    }, 4000);
  });

  document.getElementById('btn-import')?.addEventListener('click', () => {
    API.navigate(API.extension, 'cloud-files', null);
  });

  // Feature A: export handler
  document.getElementById('btn-export')?.addEventListener('click', async () => {
    const sessionId = document.getElementById('export-session').value;
    const format    = document.getElementById('export-format').value;
    const msg       = document.getElementById('export-msg');
    const btn       = document.getElementById('btn-export');
    btn.textContent = 'Exporting…'; btn.disabled = true; msg.textContent = '';

    try {
      const session = sessions.find(s => s.id === sessionId);
      if (!session) throw new Error('Session not found');

      const exported = await API.exportSessionAs(session, format);
      if (!exported?.base64) throw new Error('Export returned no data');

      // Upload the exported file using the provider's raw upload-bytes method
      const credsRaw = await API.storage.get(`creds:${activeProvider}`);
      const creds    = JSON.parse(credsRaw);
      const provider = API.providers[activeProvider];

      // For export we create a fake entry with the exported filename
      const fname = exported.filename ?? `${session.title || 'book'}.${format}`;
      await provider.uploadRaw(fname, exported.base64, creds);

      msg.style.color = '#22c55e';
      msg.textContent = `✓ Exported ${fname} to ${p.label}`;
    } catch (e) {
      msg.style.color = '#ef4444';
      msg.textContent = e.message;
    } finally {
      btn.textContent = `Export to ${p.label}`; btn.disabled = false;
    }
  });

  // Feature C: render per-book toggles
  const togglesEl = document.getElementById('book-toggles');
  if (togglesEl) {
    if (!sessions.length) {
      togglesEl.innerHTML = '<div style="color:#6b6b80;font-size:12px">No books yet.</div>';
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
    // Update subtitle
    const row = document.querySelector(`[onchange*="${sessionId}"]`)?.closest('.toggle-row');
    if (row) row.querySelector('.toggle-sub').textContent = disable ? 'Not backed up' : 'Auto-backup on';
  };
}

(async () => {
  try {
    const { activeProvider } = await getAPI().getStatus();
    if (activeProvider) await renderConnectedView();
    else renderProviderPicker();
  } catch (e) {
    document.body.innerHTML += `<div style="padding:24px;color:#ef4444;font-size:13px">
      Failed to load: ${e.message}</div>`;
  }
})();
