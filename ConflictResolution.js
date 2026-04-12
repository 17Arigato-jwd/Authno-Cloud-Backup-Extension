/**
 * ui/ConflictResolution.js — Conflict resolution page
 *
 * Shown when the cloud has a newer version of a book than the local copy.
 * The session data is passed via window.CloudBackupAPI.conflictContext.
 *
 * Options:
 *   Keep local  → force-upload the local copy (overwrites cloud)
 *   Use cloud   → download the cloud copy and replace the local session
 */

document.head.insertAdjacentHTML('beforeend', `<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    font-size:14px;color:#e4e4f0;background:#16161d;padding:20px}
  h1{font-size:18px;font-weight:600;margin-bottom:4px}
  .sub{color:#6b6b80;font-size:13px;margin-bottom:24px}
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
  .note{color:#6b6b80;font-size:12px;margin-top:16px;line-height:1.6}
</style>`);

async function init() {
  // Wait for host to inject API
  let API;
  await new Promise(res => {
    if (window.CloudBackupAPI) { API = window.CloudBackupAPI; res(); return; }
    const t = setInterval(() => {
      if (window.CloudBackupAPI) { clearInterval(t); API = window.CloudBackupAPI; res(); }
    }, 100);
  });

  const ctx = API.conflictContext ?? {};
  const { sessionId, title, cloudModified, providerName } = ctx;

  const localDate = new Date().toLocaleString();   // approximate — local is "just now"
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

    <p class="note">
      "Keep local" will overwrite the cloud version with your current edits.<br>
      "Use cloud" will replace your current edits with the cloud version.<br>
      <strong>This cannot be undone.</strong>
    </p>
  `;

  document.getElementById('btn-keep-local').addEventListener('click', async () => {
    await API.resolveConflict(sessionId, 'keep-local');
    window.history.back();
  });

  document.getElementById('btn-use-cloud').addEventListener('click', async () => {
    const btn = document.getElementById('btn-use-cloud');
    btn.textContent = 'Downloading…';
    btn.disabled = true;
    try {
      await API.resolveConflict(sessionId, 'use-cloud');
      window.history.back();
    } catch (e) {
      btn.textContent = `Failed: ${e.message}`;
      btn.disabled = false;
    }
  });
}

init();
