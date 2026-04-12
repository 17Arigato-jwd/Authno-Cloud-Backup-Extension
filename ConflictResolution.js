/**
 * ui/ConflictResolution.js — v1.2.0
 *
 * Changes from v1.1.0:
 *   - Reads conflict context from extension storage via the API bridge
 *     (storage.get('conflictContext')) instead of API.conflictContext which
 *     was never populated. index.js now writes the context to storage before
 *     calling navigate(), so it's always available when this page loads.
 *   - Replaced window.history.back() with window.parent.postMessage({ type:
 *     'ext-close' }) because history.back() inside a sandboxed iframe only
 *     affects the iframe's own history stack (length 1) and never navigates
 *     the app back to the previous view.
 *   - getAPI() waits for CloudBackupAPI synchronously (it's injected by the
 *     bridge shim before this script runs) with a short polling fallback.
 */

document.head.insertAdjacentHTML('beforeend', `<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    font-size:14px;color:#e4e4f0;background:transparent;padding:20px}
  h1{font-size:18px;font-weight:600;margin-bottom:4px}
  .sub{color:#6b6b80;font-size:13px;margin-bottom:24px;line-height:1.5}
  .card{background:#1f1f2a;border:1px solid #2e2e3a;border-radius:12px;padding:16px;margin-bottom:12px}
  .card h2{font-size:13px;font-weight:600;color:#6b6b80;text-transform:uppercase;
    letter-spacing:.05em;margin-bottom:8px}
  .version-row{display:flex;align-items:center;gap:10px;padding:10px 0;
    border-bottom:1px solid #2e2e3a}
  .version-row:last-child{border-bottom:none}
  .badge{font-size:11px;padding:2px 8px;border-radius:99px;font-weight:500}
  .badge-local{background:#6366f122;color:#818cf8;border:1px solid #6366f133}
  .badge-cloud{background:#22c55e22;color:#4ade80;border:1px solid #22c55e33}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 18px;
    border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:500;width:100%;
    justify-content:center;margin-bottom:8px}
  .btn-local{background:#6366f1;color:#fff}
  .btn-cloud{background:#22c55e;color:#000}
  .btn:disabled{opacity:0.5;cursor:not-allowed}
  .note{color:#6b6b80;font-size:12px;margin-top:16px;line-height:1.6}
  .err{color:#ef4444;font-size:12px;margin-top:8px}
</style>`);

function getAPI() {
  return window.CloudBackupAPI ?? null;
}

function closePage() {
  // Signal ExtensionPage.jsx to call onBack() — history.back() is a no-op in iframes
  window.parent.postMessage({ type: 'ext-close' }, '*');
}

async function init() {
  // Bridge shim is injected synchronously before this script; tiny poll as safety net
  let API = getAPI();
  if (!API) {
    await new Promise(res => {
      const t = setInterval(() => {
        if (window.CloudBackupAPI) { clearInterval(t); API = window.CloudBackupAPI; res(); }
      }, 50);
      setTimeout(() => { clearInterval(t); res(); }, 3000);
    });
  }

  if (!API) {
    document.body.innerHTML = `<div style="padding:20px;color:#ef4444">Extension API not available.</div>`;
    return;
  }

  // Read conflict context from extension storage (written by index.js before navigate)
  let ctx = {};
  try {
    const raw = await API.storage.get('conflictContext');
    if (raw) ctx = JSON.parse(raw);
  } catch (_) {}

  const { sessionId, title, cloudModified, providerName } = ctx;

  const localDate = new Date().toLocaleString();
  const cloudDate = cloudModified ? new Date(cloudModified).toLocaleString() : 'Unknown';

  document.body.innerHTML = `
    <h1>⚠️ Sync conflict</h1>
    <p class="sub">
      <strong>${title || 'This book'}</strong> was modified on ${providerName || 'your cloud provider'}
      after your last upload. Choose which version to keep.
    </p>

    <div class="card">
      <h2>Versions</h2>
      <div class="version-row">
        <span class="badge badge-local">This device</span>
        <span style="flex:1">Current local copy</span>
        <span style="font-size:12px;color:#6b6b80">${localDate}</span>
      </div>
      <div class="version-row">
        <span class="badge badge-cloud">${providerName || 'Cloud'}</span>
        <span style="flex:1">Remote version</span>
        <span style="font-size:12px;color:#6b6b80">${cloudDate}</span>
      </div>
    </div>

    <button class="btn btn-local" id="btn-keep-local">Keep local copy</button>
    <button class="btn btn-cloud" id="btn-use-cloud">Use cloud version</button>
    <div class="err" id="err-msg"></div>

    <p class="note">
      "Keep local" will overwrite the cloud version with your current edits.<br>
      "Use cloud" will replace your current edits with the cloud version.<br>
      <strong>This cannot be undone.</strong>
    </p>
  `;

  document.getElementById('btn-keep-local').addEventListener('click', async () => {
    try {
      await API.resolveConflict(sessionId, 'keep-local');
      await API.storage.set('conflictContext', null);
      closePage();
    } catch (e) {
      document.getElementById('err-msg').textContent = e.message;
    }
  });

  document.getElementById('btn-use-cloud').addEventListener('click', async () => {
    const btn = document.getElementById('btn-use-cloud');
    btn.textContent = 'Downloading…';
    btn.disabled = true;
    try {
      await API.resolveConflict(sessionId, 'use-cloud');
      await API.storage.set('conflictContext', null);
      closePage();
    } catch (e) {
      document.getElementById('err-msg').textContent = e.message;
      btn.textContent = 'Use cloud version';
      btn.disabled = false;
    }
  });
}

init();
