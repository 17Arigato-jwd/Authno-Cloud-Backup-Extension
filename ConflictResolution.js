import { API } from './pageApi.js';

/**
 * ui/ConflictResolution.js — v1.3.0
 *
 * Changes from v1.2.0:
 *   - Side-by-side comparison panel showing local vs cloud metadata
 *     (word count, chapter count, last-modified dates). Cloud content is
 *     fetched live; local numbers come from the library listing.
 *   - "Keep local version" now reveals two sub-buttons instead of resolving
 *     immediately:
 *       • "Keep local, don't update cloud" → resolveConflict(id, 'keep-local-no-upload')
 *         Discards the conflict without re-queuing. Cloud version is kept as-is.
 *       • "Keep local + overwrite cloud"   → resolveConflict(id, 'keep-local')
 *         Re-queues the session for upload (existing behaviour).
 *   - "Use cloud version" button is unchanged.
 *   - Expanded .err style to show multi-line messages.
 */

document.head.insertAdjacentHTML('beforeend', `<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px; color: #e4e4f0; background: transparent; padding: 20px 16px 32px; }

  h1  { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
  .sub { color: #6b6b80; font-size: 13px; margin-bottom: 20px; line-height: 1.5; }

  .card { background: #1f1f2a; border: 1px solid #2e2e3a; border-radius: 12px;
    padding: 14px 16px; margin-bottom: 12px; }
  .card-title { font-size: 11px; font-weight: 600; color: #6b6b80;
    text-transform: uppercase; letter-spacing: .06em; margin-bottom: 10px; }

  /* ── Version meta row ──────────────────────────────────────────────────── */
  .version-row { display: flex; align-items: center; gap: 10px; padding: 9px 0;
    border-bottom: 1px solid #2e2e3a; }
  .version-row:last-child { border-bottom: none; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; font-weight: 500;
    white-space: nowrap; }
  .badge-local { background: #6366f122; color: #818cf8; border: 1px solid #6366f133; }
  .badge-cloud { background: #22c55e22; color: #4ade80; border: 1px solid #22c55e33; }
  .version-label { flex: 1; font-size: 13px; }
  .version-date  { font-size: 12px; color: #6b6b80; }

  /* ── Side-by-side comparison ───────────────────────────────────────────── */
  .compare-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
    margin-bottom: 12px;
  }
  .compare-col {
    background: #16161d; border: 1px solid #2e2e3a; border-radius: 10px;
    padding: 12px 12px 14px;
  }
  .compare-col-header {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .08em; margin-bottom: 10px;
  }
  .compare-col-header.local { color: #818cf8; }
  .compare-col-header.cloud { color: #4ade80; }
  .compare-stat {
    margin-bottom: 8px;
  }
  .compare-stat-label { font-size: 10px; color: #5a5a70; margin-bottom: 2px; }
  .compare-stat-value { font-size: 13px; font-weight: 600; color: #ddddf0; }
  .compare-stat-value.highlight { color: #fbbf24; }  /* differs from other side */
  .compare-loading { font-size: 11px; color: #5a5a70; padding: 8px 0; }
  .compare-err     { font-size: 11px; color: #f87171; padding: 4px 0; }

  /* ── Action buttons ────────────────────────────────────────────────────── */
  .btn { display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 11px 18px; border-radius: 10px; border: none; cursor: pointer;
    font-size: 13px; font-weight: 600; width: 100%; margin-bottom: 8px;
    transition: filter .15s; }
  .btn:hover    { filter: brightness(1.08); }
  .btn:disabled { opacity: .5; cursor: not-allowed; filter: none; }
  .btn-local { background: #4f46e5; color: #fff; }
  .btn-cloud { background: #16a34a; color: #fff; }
  .btn-sub   { background: #1f1f2a; border: 1px solid #3a3a4e;
    color: #c0c0e0; font-size: 12px; padding: 9px 14px; }
  .btn-sub-danger { background: #2a1a1a; border: 1px solid #6b2020;
    color: #fca5a5; font-size: 12px; padding: 9px 14px; }

  /* Sub-button container — slides down when "Keep local" is clicked */
  .sub-btn-group {
    overflow: hidden; max-height: 0; opacity: 0;
    transition: max-height .28s cubic-bezier(.4,0,.2,1), opacity .2s ease;
    margin-bottom: 0;
  }
  .sub-btn-group.open { max-height: 140px; opacity: 1; margin-bottom: 8px; }

  .note { color: #6b6b80; font-size: 12px; margin-top: 8px; line-height: 1.6; }
  .err  { color: #ef4444; font-size: 12px; margin-top: 8px; line-height: 1.4; }
  .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #2e2e3a;
    border-top-color: #6366f1; border-radius: 50%;
    animation: spin .7s linear infinite; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function closePage() { API.close(); }

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(iso) {
  if (!iso) return 'Unknown';
  return new Date(iso).toLocaleString(undefined,
    { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

/** Extract plain text from a session's chapters array (best effort). */
function sessionWordCount(session) {
  if (!session?.chapters?.length) return null;
  let total = 0;
  for (const ch of session.chapters) {
    // chapters may have { text } or { content } or { blocks: [{ text }] }
    const raw = ch.text ?? ch.content ?? '';
    if (typeof raw === 'string') { total += countWords(raw); continue; }
    if (Array.isArray(ch.blocks)) {
      for (const b of ch.blocks) total += countWords(b.text ?? b.content ?? '');
    }
  }
  return total;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function init() {
  // No wait-for-the-global loop. v1 polled every 50ms for up to three seconds
  // hoping window.CloudBackupAPI would appear, because the background half
  // installed it whenever it happened to finish activating. The host installs
  // `authno` before any module in this frame runs, so it is simply there.
  const ctx = (await API.storage.getJSON('conflictContext', {})) ?? {};

  const { sessionId, title, cloudModified, providerName } = ctx;
  const localDate = fmtDate(new Date().toISOString());
  const cloudDate = fmtDate(cloudModified);

  // Render the skeleton immediately so the user sees something right away
  document.body.innerHTML = `
    <h1>⚠️ Sync conflict</h1>
    <p class="sub">
      <strong>${esc(title || 'This book')}</strong> was modified on
      ${esc(providerName || 'your cloud provider')} after your last upload.
      Choose which version to keep.
    </p>

    <!-- Version meta -->
    <div class="card">
      <div class="card-title">Versions</div>
      <div class="version-row">
        <span class="badge badge-local">This device</span>
        <span class="version-label">Current local copy</span>
        <span class="version-date">${esc(localDate)}</span>
      </div>
      <div class="version-row">
        <span class="badge badge-cloud">${esc(providerName || 'Cloud')}</span>
        <span class="version-label">Remote version</span>
        <span class="version-date">${esc(cloudDate)}</span>
      </div>
    </div>

    <!-- Side-by-side comparison -->
    <div class="compare-grid" id="compare-grid">
      <div class="compare-col">
        <div class="compare-col-header local">📱 Local</div>
        <div id="local-stats"><div class="compare-loading"><span class="spinner"></span> Loading…</div></div>
      </div>
      <div class="compare-col">
        <div class="compare-col-header cloud">☁️ Cloud</div>
        <div id="cloud-stats"><div class="compare-loading"><span class="spinner"></span> Fetching…</div></div>
      </div>
    </div>

    <!-- Keep local (reveals sub-buttons) -->
    <button class="btn btn-local" id="btn-keep-local">Keep local version ▾</button>

    <!-- Sub-button group (hidden until Keep local is clicked) -->
    <div class="sub-btn-group" id="sub-btn-group">
      <button class="btn btn-sub" id="btn-keep-no-upload">
        Keep local — leave cloud version as-is
      </button>
      <button class="btn btn-sub-danger" id="btn-keep-overwrite">
        Keep local — overwrite cloud with local
      </button>
    </div>

    <!-- Use cloud -->
    <button class="btn btn-cloud" id="btn-use-cloud">Use cloud version</button>

    <div class="err" id="err-msg"></div>

    <p class="note">
      <strong>This cannot be undone.</strong><br>
      "Leave cloud as-is" discards the conflict — both versions survive but cloud stays ahead.<br>
      "Overwrite cloud" uploads your local copy to replace the cloud version.
    </p>
  `;

  // ── Load local stats ───────────────────────────────────────────────────────
  (async () => {
    try {
      const sessions   = (await API.getSessions()) ?? [];
      const local      = sessions.find(s => s.id === sessionId);
      const localEl    = document.getElementById('local-stats');
      if (!localEl) return;
      if (!local) {
        localEl.innerHTML = `<div class="compare-err">Session not found on device.</div>`;
        return;
      }
      // Straight off the listing. `library.list` computes wordCount and
      // chapterCount host-side and returns no chapter text at all, so this
      // page shows the two numbers the choice turns on without a manuscript
      // ever crossing into it. v1 counted the words here, which meant every
      // chapter of the book was in this frame to be counted.
      const wc = typeof local.wordCount === 'number' ? local.wordCount : null;
      const ch = typeof local.chapterCount === 'number' ? local.chapterCount : '?';
      localEl.innerHTML = `
        <div class="compare-stat">
          <div class="compare-stat-label">Title</div>
          <div class="compare-stat-value">${esc(local.title || 'Untitled')}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">Chapters</div>
          <div class="compare-stat-value" id="local-ch">${ch}</div>
        </div>
        ${wc !== null ? `
        <div class="compare-stat">
          <div class="compare-stat-label">Word count</div>
          <div class="compare-stat-value" id="local-wc">${wc.toLocaleString()}</div>
        </div>` : ''}
      `;
    } catch (e) {
      const el = document.getElementById('local-stats');
      if (el) el.innerHTML = `<div class="compare-err">${esc(e.message)}</div>`;
    }
  })();

  // ── Load cloud stats ───────────────────────────────────────────────────────
  (async () => {
    const cloudEl = document.getElementById('cloud-stats');
    try {
      // The background half downloads it; this page never sees a token.
      const { base64 } = await API.downloadCloudFile(sessionId);

      // Decode the .authbook — it may be a JSON envelope or gzip'd JSON.
      // Try plain JSON first, then fall back to showing just the byte size.
      let cloudWc   = null;
      let cloudCh   = null;
      let decodeErr = null;
      try {
        const raw       = atob(base64);
        const parsed    = JSON.parse(raw);
        // .authbook is typically { session: { chapters: [...] } } or { chapters: [...] }
        const session   = parsed.session ?? parsed;
        cloudCh = session.chapters?.length ?? null;
        cloudWc = sessionWordCount(session);
      } catch (e) {
        decodeErr = 'Could not parse content (may be encrypted or compressed)';
      }

      if (!cloudEl) return;

      const sizeKB = Math.round((base64.length * 0.75) / 1024);

      cloudEl.innerHTML = `
        <div class="compare-stat">
          <div class="compare-stat-label">Modified</div>
          <div class="compare-stat-value" style="font-size:11px">${esc(cloudDate)}</div>
        </div>
        <div class="compare-stat">
          <div class="compare-stat-label">File size</div>
          <div class="compare-stat-value">${sizeKB} KB</div>
        </div>
        ${cloudCh !== null ? `
        <div class="compare-stat">
          <div class="compare-stat-label">Chapters</div>
          <div class="compare-stat-value" id="cloud-ch">${cloudCh}</div>
        </div>` : ''}
        ${cloudWc !== null ? `
        <div class="compare-stat">
          <div class="compare-stat-label">Word count</div>
          <div class="compare-stat-value" id="cloud-wc">${cloudWc.toLocaleString()}</div>
        </div>` : ''}
        ${decodeErr ? `<div class="compare-err">${esc(decodeErr)}</div>` : ''}
      `;

      // Highlight differing chapter/word counts
      _highlightDiff('local-ch',  'cloud-ch');
      _highlightDiff('local-wc',  'cloud-wc');

    } catch (e) {
      if (cloudEl) cloudEl.innerHTML = `<div class="compare-err">${esc(e.message)}</div>`;
    }
  })();

  // ── Keep local → reveal sub-buttons ───────────────────────────────────────
  document.getElementById('btn-keep-local').addEventListener('click', () => {
    const group = document.getElementById('sub-btn-group');
    const btn   = document.getElementById('btn-keep-local');
    const open  = group.classList.toggle('open');
    btn.textContent = open ? 'Keep local version ▴' : 'Keep local version ▾';
  });

  // Sub-option 1: discard conflict, do NOT re-queue upload
  document.getElementById('btn-keep-no-upload').addEventListener('click', async () => {
    _setAllDisabled(true);
    try {
      await API.resolveConflict(sessionId, 'keep-local-no-upload');
      await API.storage.set('conflictContext', null);
      closePage();
    } catch (e) {
      document.getElementById('err-msg').textContent = e.message;
      _setAllDisabled(false);
    }
  });

  // Sub-option 2: keep local AND overwrite cloud (existing behaviour)
  document.getElementById('btn-keep-overwrite').addEventListener('click', async () => {
    _setAllDisabled(true);
    try {
      await API.resolveConflict(sessionId, 'keep-local');
      await API.storage.set('conflictContext', null);
      closePage();
    } catch (e) {
      document.getElementById('err-msg').textContent = e.message;
      _setAllDisabled(false);
    }
  });

  // Use cloud version
  document.getElementById('btn-use-cloud').addEventListener('click', async () => {
    const btn = document.getElementById('btn-use-cloud');
    btn.textContent = 'Downloading…';
    _setAllDisabled(true);
    try {
      await API.resolveConflict(sessionId, 'use-cloud');
      await API.storage.set('conflictContext', null);
      closePage();
    } catch (e) {
      document.getElementById('err-msg').textContent = e.message;
      btn.textContent = 'Use cloud version';
      _setAllDisabled(false);
    }
  });
}

/** Mark both stat values with highlight class if they differ. */
function _highlightDiff(localId, cloudId) {
  const lEl = document.getElementById(localId);
  const cEl = document.getElementById(cloudId);
  if (!lEl || !cEl) return;
  const lv = parseInt(lEl.textContent.replace(/,/g, ''), 10);
  const cv = parseInt(cEl.textContent.replace(/,/g, ''), 10);
  if (!isNaN(lv) && !isNaN(cv) && lv !== cv) {
    lEl.classList.add('highlight');
    cEl.classList.add('highlight');
  }
}

function _setAllDisabled(disabled) {
  ['btn-keep-local', 'btn-keep-no-upload', 'btn-keep-overwrite', 'btn-use-cloud']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    });
}

init();
