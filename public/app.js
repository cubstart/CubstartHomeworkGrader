const $ = (s) => document.querySelector(s);
// nodeEntry/app/tests: the student's Node.js server file, its process status, and test results (API tab)
const state = { assignment: null, subs: [], sub: null, files: [], entry: null, file: null, port: null, dbOk: false, rubric: [], nodeEntry: null, app: null, tests: null };

const IMG = /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/i;
const MEDIA = /\.(mp4|webm|mov|mp3|wav|ogg)$/i;
const BINARY = /\.(pdf|zip|woff2?|ttf|otf|eot)$/i;
const LANG = { js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', css: 'css', html: 'xml', htm: 'xml', json: 'json', md: 'markdown', py: 'python', svg: 'xml' };

// Each submission is served from its own port (its own origin) on the same loopback host as the UI
const fileUrl = (p) => `${location.protocol}//${location.hostname}:${state.port}/${p.split('/').map(encodeURIComponent).join('/')}`;
const api = (p, opts) => fetch(p, opts).then((r) => r.json());

// ---------- Importing ----------

async function loadStatus() {
  const s = await api('/api/status');
  state.dbOk = s.db === 'connected';
  state.rubric = s.rubric || [];
  if (state.rubric.length) $('#hint').textContent = `j / k to switch students · 1-${state.rubric.length} to grade · g to toggle graded · Esc leaves the comment box`;
  const el = $('#dbStatus');
  el.textContent = state.dbOk ? `Grading as ${s.grader}` : s.db === 'not configured' ? 'Grading status off' : `MongoDB ${s.db}`;
  el.title = state.dbOk ? 'Grading status is saved to MongoDB' : s.dbError || 'Set MONGODB_URI in .env to save grading status';
  el.className = 'pill ' + (state.dbOk ? 'ok' : 'bad');
  if (s.db === 'connecting') setTimeout(loadStatus, 2000);
  renderSubs();
}

async function importZip(file) {
  if (!file || $('#importBtn').disabled) return;
  if (!/\.zip$/i.test(file.name)) { alert('Please choose a .zip file (Gradescope → Review Grades → Export Submissions).'); return; }
  $('#importBtn').disabled = true;
  $('#progress').hidden = false;
  $('#barFill').style.width = '0';
  $('#log').textContent = `Uploading ${file.name} (${(file.size / 1e6).toFixed(1)} MB)…`;
  const done = () => { $('#importBtn').disabled = false; $('#zipInput').value = ''; };
  const res = await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Filename': encodeURIComponent(file.name) }, body: file })
    .catch((e) => ({ error: e.message }));
  if (!res.jobId) { $('#log').textContent += `\nError: ${res.error || 'upload failed'}`; return done(); }
  const t = setInterval(async () => {
    const j = await api(`/api/jobs/${res.jobId}`);
    $('#barFill').style.width = j.total ? `${(100 * j.done) / j.total}%` : '0';
    $('#log').textContent = j.logs.join('\n');
    $('#log').scrollTop = 1e9;
    if (j.status !== 'running') {
      clearInterval(t);
      done();
      if (j.assignmentId) await loadAssignments(j.assignmentId);
    }
  }, 500);
}

$('#importBtn').onclick = () => $('#zipInput').click();
$('#zipInput').onchange = (e) => importZip(e.target.files[0]);

// Accept a drop anywhere in the window
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dropping'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  importZip(e.dataTransfer.files[0]);
});

// ---------- Assignments & submissions ----------

async function loadAssignments(select) {
  const list = await api('/api/assignments');
  $('#assignment').innerHTML = list.length
    ? list.map((a) => `<option value="${esc(a.assignmentId)}">Assignment ${esc(a.assignmentId)} (${a.count})</option>`).join('')
    : '<option>No assignments imported yet</option>';
  const pick = select || localStorage.getItem('assignment') || list[0]?.assignmentId;
  if (pick && list.some((a) => a.assignmentId === pick)) {
    $('#assignment').value = pick;
    await loadAssignment(pick);
  }
}

$('#assignment').onchange = (e) => loadAssignment(e.target.value);

async function loadAssignment(aid) {
  if (commentTimer) saveComment(); // unsaved comment for the student we're leaving
  state.assignment = aid;
  localStorage.setItem('assignment', aid);
  const a = await api(`/api/assignments/${aid}`);
  state.subs = a.submissions;
  renderSubs();
  if (state.subs.length) selectSub(state.subs[0].id);
}

function visibleSubs() {
  const q = $('#filter').value.toLowerCase();
  const hideGraded = $('#hideGraded').checked;
  // The open student stays listed after being marked graded, so j / k still work from it
  return state.subs.filter((s) => `${s.name} ${s.email || ''}`.toLowerCase().includes(q) && !(hideGraded && s.graded && s.id !== state.sub?.id));
}

// "5/5" for a graded submission with a score (0 is a valid score), else ""
const scoreOf = (s) => (s.graded && s.score != null ? `${s.score}/${s.maxScore}` : '');
const when = (d) => (d ? new Date(d).toLocaleString() : '');

function renderSubs() {
  $('#subList').innerHTML = visibleSubs().map((s) => {
    const score = scoreOf(s);
    const tip = s.error || [
      s.email,
      s.graded && `Graded by ${s.gradedBy || '?'} ${when(s.updatedAt)}`,
      score && `Score ${score}${s.rubric ? ` · ${s.rubric}` : ''}`,
      s.comment && `Comment: ${s.comment}`,
    ].filter(Boolean).join('\n') || s.name;
    return `<li data-id="${esc(s.id)}" class="${s.id === state.sub?.id ? 'active' : ''} ${s.error ? 'err' : ''} ${s.graded ? 'graded' : ''}" title="${esc(tip)}"><span class="check">${s.graded ? '✓' : ''}</span>${score ? `<span class="score">${esc(score)}</span>` : ''}${esc(s.name)}</li>`;
  }).join('');
  const graded = state.subs.filter((s) => s.graded);
  const scored = graded.filter((s) => s.score != null);
  const avg = scored.length ? ` · avg ${(scored.reduce((t, s) => t + s.score, 0) / scored.length).toFixed(1)}` : '';
  $('#gradedCount').textContent = state.dbOk && state.subs.length ? `${graded.length} / ${state.subs.length} graded${avg}` : '';
  const cur = state.sub;
  $('#gradeBtn').hidden = !state.dbOk || !cur;
  $('#gradeBtn').textContent = cur?.graded ? `✓ ${scoreOf(cur) || 'Graded'}` : 'Mark as graded';
  $('#gradeBtn').title = cur?.graded ? `Graded by ${cur.gradedBy || '?'}. Click (or press g) to undo` : 'Click or press g';
  $('#gradeBtn').classList.toggle('done', !!cur?.graded);
  renderGradePanel();
}

$('#filter').oninput = renderSubs;
$('#hideGraded').onchange = renderSubs;

// ---------- Grading ----------

const GRADE_KEYS = ['graded', 'score', 'maxScore', 'rubric', 'comment', 'gradedBy', 'updatedAt'];
const commentEl = $('#comment');
let commentTimer = null; // pending debounced comment save; also means "unsaved edits"
let metaFlash = null; // transient text for #gradeMeta, e.g. "Saved"

// Sends a patch ({ rubric: i } | { graded } | { comment }) and applies the saved grade. The
// optimistic fields show immediately and are rolled back if the save fails.
async function saveGrade(sub, patch, optimistic) {
  if (!sub || !state.dbOk) return false;
  const prev = Object.fromEntries(GRADE_KEYS.map((k) => [k, sub[k]]));
  const url = `/api/assignments/${encodeURIComponent(state.assignment)}/${encodeURIComponent(sub.id)}/grade`;
  Object.assign(sub, optimistic);
  renderSubs();
  try {
    const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    for (const k of GRADE_KEYS) sub[k] = body[k]; // fields missing from the saved doc are cleared
    renderSubs();
    return true;
  } catch (e) {
    Object.assign(sub, prev);
    renderSubs();
    alert(`Could not save grade: ${e.message}`);
    return false;
  }
}

function toggleGraded(sub = state.sub) {
  if (!sub) return;
  const graded = !sub.graded;
  return saveGrade(sub, { graded }, { graded, score: undefined, maxScore: undefined, rubric: undefined });
}

// Grades with rubric item i. With toggle (a click), choosing the selected item clears the grade.
function pickRubric(i, toggle = false, sub = state.sub) {
  const item = state.rubric[i];
  if (!sub || !item) return;
  const selected = sub.graded && sub.score === item.points && sub.rubric === item.label;
  if (selected) return toggle ? toggleGraded(sub) : undefined;
  const maxScore = Math.max(...state.rubric.map((r) => r.points));
  return saveGrade(sub, { rubric: i }, { graded: true, score: item.points, maxScore, rubric: item.label });
}

$('#gradeBtn').onclick = () => toggleGraded();
$('#rubric').onclick = (e) => { const b = e.target.closest('button[data-i]'); if (b) pickRubric(Number(b.dataset.i), true); };

function setMeta(text, cls, ms) {
  clearTimeout(metaFlash?.timer);
  metaFlash = { text, cls };
  if (ms) metaFlash.timer = setTimeout(() => { metaFlash = null; renderGradePanel(); }, ms);
  renderGradePanel();
}

// Saves the comment box for sub if it differs from what is stored
function saveComment(sub = state.sub) {
  clearTimeout(commentTimer);
  commentTimer = null;
  if (!sub || !state.dbOk) return;
  const text = commentEl.value.trim();
  if (text === (sub.comment || '')) return;
  if (sub === state.sub) setMeta('Saving…', 'saving');
  saveGrade(sub, { comment: text }, { comment: text || undefined }).then((ok) => {
    if (sub !== state.sub) return;
    if (ok) setMeta('Saved', 'saved', 1500); else { metaFlash = null; renderGradePanel(); }
  });
}

commentEl.oninput = () => { clearTimeout(commentTimer); commentTimer = setTimeout(saveComment, 800); };
commentEl.onblur = () => saveComment();
commentEl.onkeydown = (e) => {
  // Esc or Ctrl/Cmd+Enter leaves the box (which saves) so j / k / digits work again
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commentEl.blur(); }
};

function renderGradePanel() {
  const sub = state.sub;
  const panel = $('#gradePanel');
  panel.hidden = !state.dbOk || !sub;
  if (panel.hidden) return;
  $('#rubric').innerHTML = state.rubric.map((r, i) => {
    const on = sub.graded && sub.score === r.points && sub.rubric === r.label;
    return `<button data-i="${i}" class="${on ? 'selected' : ''}" title="${on ? 'Click to clear this grade' : `Press ${i + 1}`}"><kbd>${i + 1}</kbd><b>+${r.points}</b>${esc(r.label)}</button>`;
  }).join('');
  // Never overwrite text being typed or not yet saved
  if (document.activeElement !== commentEl && !commentTimer) commentEl.value = sub.comment || '';
  const meta = $('#gradeMeta');
  if (metaFlash) { meta.textContent = metaFlash.text; meta.className = metaFlash.cls; return; }
  meta.className = '';
  meta.textContent = sub.graded ? `Graded by ${sub.gradedBy || '?'} · ${when(sub.updatedAt)}`
    : sub.comment ? `Comment by ${sub.gradedBy || '?'} · not graded yet` : 'Not graded yet';
}

// Pick up other graders' changes
setInterval(async () => {
  if (!state.dbOk || !state.assignment || document.hidden) return;
  const aid = state.assignment;
  const grades = await api(`/api/assignments/${encodeURIComponent(aid)}/grades`).catch(() => null);
  if (!grades || grades.error || aid !== state.assignment) return;
  const cleared = Object.fromEntries(GRADE_KEYS.map((k) => [k, undefined]));
  for (const s of state.subs) Object.assign(s, cleared, { graded: false }, grades[s.id]);
  renderSubs();
}, 10000);
$('#subList').onclick = (e) => { const li = e.target.closest('li'); if (li) selectSub(li.dataset.id); };

async function selectSub(id) {
  if (commentTimer) saveComment(); // unsaved comment for the student we're leaving
  clearTimeout(metaFlash?.timer);
  metaFlash = null;
  state.sub = state.subs.find((s) => s.id === id);
  renderSubs();
  const { files, entry, port, nodeEntry, app } = await api(`/api/assignments/${state.assignment}/${id}/files`);
  if (state.sub?.id !== id) return; // the grader moved on while this loaded
  state.port = port;
  state.files = files;
  state.entry = entry;
  state.nodeEntry = nodeEntry || null;
  state.app = app || null;
  state.tests = null;
  renderTree();
  showPreview();
  openFile(nodeEntry || entry || files[0]?.path || null, false);
  if (nodeEntry) runTests();
}

// ---------- File tree ----------

function renderTree() {
  $('#fileList').innerHTML = state.files.length
    ? state.files.map((f) => {
        const i = f.path.lastIndexOf('/');
        const dir = i >= 0 ? `<span class="dir">${esc(f.path.slice(0, i + 1))}</span>` : '';
        return `<li data-path="${esc(f.path)}" class="${f.path === state.file ? 'active' : ''}" title="${esc(f.path)}">${dir}${esc(f.path.slice(i + 1))}</li>`;
      }).join('')
    : `<li class="err">${state.sub?.error ? esc(state.sub.error) : 'No files'}</li>`;
}

$('#fileList').onclick = (e) => {
  const li = e.target.closest('li[data-path]');
  if (!li) return;
  openFile(li.dataset.path, true);
  // Clicking an HTML file also previews it
  if (/\.html?$/i.test(li.dataset.path)) { state.entry = li.dataset.path; showPreview(false); }
};

// ---------- Viewer ----------

function setTab(tab) {
  document.querySelectorAll('.tabs button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#previewPane').hidden = tab !== 'preview';
  $('#sourcePane').hidden = tab !== 'source';
  $('#apiPane').hidden = tab !== 'api';
}
document.querySelectorAll('.tabs button[data-tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

function showPreview(switchTab = true) {
  const has = !!state.entry;
  const node = !!state.nodeEntry;
  $('#frame').hidden = !has;
  $('#noPreview').hidden = has;
  $('#openTab').hidden = !has;
  $('.tabs button[data-tab="api"]').hidden = !node;
  if (has) {
    const u = fileUrl(state.entry);
    $('#frame').src = u;
    $('#openTab').href = u;
    $('#current').textContent = state.entry;
  } else {
    $('#frame').src = 'about:blank';
    $('#current').textContent = '';
  }
  if (node) { $('#current').textContent = state.nodeEntry; renderApp(); }
  if (switchTab) setTab(node ? 'api' : has ? 'preview' : 'source');
}

async function openFile(p, switchTab) {
  state.file = p;
  renderTree();
  const body = $('#sourceBody');
  if (!p) { body.className = 'empty'; body.textContent = 'No files.'; return; }
  if (switchTab) { setTab('source'); $('#current').textContent = p; }
  const u = fileUrl(p);
  body.className = '';
  if (IMG.test(p)) body.innerHTML = `<img src="${u}">`;
  else if (MEDIA.test(p)) body.innerHTML = `<video src="${u}" controls></video>`;
  else if (BINARY.test(p)) body.innerHTML = `<div class="empty">Binary file. <a href="${u}" target="_blank">Open</a></div>`;
  else {
    const text = await fetch(u).then((r) => r.text());
    const lang = LANG[p.split('.').pop().toLowerCase()];
    const code = document.createElement('code');
    code.textContent = text;
    if (lang) code.className = `language-${lang}`;
    body.innerHTML = '<pre></pre>';
    body.firstChild.appendChild(code);
    if (window.hljs && text.length < 300000) hljs.highlightElement(code);
  }
}

// ---------- Resizable columns ----------

const main = document.querySelector('main');
const MIN_COL = 120;
const MIN_VIEWER = 300;

function loadWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem('colWidths') || '{}');
    for (const [k, v] of Object.entries(saved)) main.style.setProperty(k, `${v}px`);
  } catch { /* storage unavailable: keep defaults */ }
}

function saveWidths() {
  try {
    const out = {};
    document.querySelectorAll('.gutter').forEach((g) => (out[g.dataset.var] = g.previousElementSibling.offsetWidth));
    localStorage.setItem('colWidths', JSON.stringify(out));
  } catch { /* ignore */ }
}

document.querySelectorAll('.gutter').forEach((gutter) => {
  const col = gutter.previousElementSibling;
  gutter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = col.offsetWidth;
    const viewerW = $('#viewer').offsetWidth;
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add('dragging');
    document.body.classList.add('resizing');

    const move = (ev) => {
      const w = Math.max(MIN_COL, Math.min(startW + ev.clientX - startX, startW + viewerW - MIN_VIEWER));
      main.style.setProperty(gutter.dataset.var, `${w}px`);
    };
    const up = () => {
      gutter.removeEventListener('pointermove', move);
      gutter.classList.remove('dragging');
      document.body.classList.remove('resizing');
      saveWidths();
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up, { once: true });
  });
  // Double-click resets that column to its default width
  gutter.addEventListener('dblclick', () => { main.style.removeProperty(gutter.dataset.var); saveWidths(); });
});

loadWidths();

// ---------- Keyboard ----------

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'g') return toggleGraded();
  if (/^[1-9]$/.test(e.key)) return pickRubric(Number(e.key) - 1);
  if (e.key !== 'j' && e.key !== 'k') return;
  const list = visibleSubs();
  const i = list.findIndex((s) => s.id === state.sub?.id);
  const next = list[i + (e.key === 'j' ? 1 : -1)];
  if (next) selectSub(next.id);
});

// ---------- API tab (Node.js submissions) ----------

// The student's server runs as a sandboxed process on the grader; everything here goes through
// the /app proxy endpoints, so POST/DELETE requests work without Postman.
const STATUS_TEXT = { starting: 'Starting…', running: 'Running', 'no-server': 'No server started', exited: 'Exited', failed: 'Could not start' };
const appUrl = (suffix) => `/api/assignments/${encodeURIComponent(state.assignment)}/${encodeURIComponent(state.sub.id)}/app${suffix}`;
const appPost = (suffix, body = {}) => fetch(appUrl(suffix), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

function renderApp() {
  const a = state.app;
  const el = $('#appStatus');
  const ok = a?.status === 'running';
  el.textContent = !a ? 'Not started' : ok ? `Running on port ${a.port}` : a.status === 'exited' ? `Exited${a.exitCode != null ? ` (code ${a.exitCode})` : ''}` : STATUS_TEXT[a.status] || a.status;
  el.className = 'pill ' + (ok ? 'ok' : !a || a.status === 'starting' ? '' : 'bad');
  $('#appEntry').textContent = a?.error && !ok ? a.error : state.nodeEntry || '';
  $('#appEntry').title = a?.error || '';
  const log = $('#appLog');
  if (a?.logs?.length) {
    log.className = '';
    log.innerHTML = a.logs.map((l) => `<span class="${l.stream}">${esc(l.line)}</span>`).join('\n');
    log.scrollTop = 1e9;
  } else {
    log.className = 'empty';
    log.textContent = a?.status === 'starting' ? 'Starting…' : 'No output.';
  }
  renderTests();
}

function renderTests() {
  const t = state.tests;
  const table = $('#testResults');
  const results = t?.results || [];
  $('#testHint').hidden = !results.length;
  $('#testSummary').textContent = results.length ? `${results.filter((r) => r.pass).length} / ${results.length} passed · ${t.name}` : '';
  if (!t) { table.innerHTML = `<tr><td class="empty">${state.testing ? 'Starting the server and running tests…' : 'Not run.'}</td></tr>`; return; }
  if (!results.length) { table.innerHTML = `<tr><td class="empty">Could not run: ${esc(t.error || state.app?.error || 'the server is not running')}</td></tr>`; return; }
  table.innerHTML = results.map((r, i) => `<tr data-i="${i}" class="${r.pass ? 'pass' : 'fail'} ${i === state.testRow ? 'active' : ''}" title="Show this response">
    <td class="mark">${r.pass ? '✓' : '✗'}</td><td>${esc(r.name)}</td><td class="req">${esc(r.method)} ${esc(r.path)}</td>
    <td class="status">${r.ok ? `${r.status} · ${r.ms} ms` : ''}</td><td class="reason">${esc(r.reason || '')}${r.tried ? ` (tried ${esc(r.tried.join(', '))})` : ''}</td></tr>`).join('');
}

// Restarts the server (fresh state) and runs the assignment's checks against it
async function runTests() {
  const sub = state.sub;
  if (!sub || !state.nodeEntry) return;
  state.tests = null;
  state.testRow = null;
  state.testing = true;
  $('#testBtn').disabled = true;
  renderTests();
  const r = await appPost('/test').catch((e) => ({ error: e.message }));
  if (sub !== state.sub) return;
  state.testing = false;
  $('#testBtn').disabled = false;
  if (r.app) state.app = r.app;
  state.tests = r.error ? { name: 'Tests', results: [], error: r.error } : r;
  renderApp();
}

async function restartApp() {
  const sub = state.sub;
  if (!sub || !state.nodeEntry) return;
  $('#restartBtn').disabled = true;
  state.app = { ...state.app, status: 'starting', port: null, error: null, logs: [] };
  state.tests = null;
  renderApp();
  const a = await appPost('/restart').catch((e) => ({ status: 'failed', error: e.message, logs: [] }));
  $('#restartBtn').disabled = false;
  if (sub !== state.sub) return;
  state.app = a;
  renderApp();
}

function showResponse(spec, r) {
  const meta = $('#reqMeta');
  const out = $('#reqResponse');
  const line = `${spec.method} ${spec.path}${spec.body ? ` ${spec.body}` : ''}`;
  if (!r.ok) {
    meta.className = 'hint bad';
    meta.textContent = `${line} → ${r.error || 'failed'}`;
    out.className = 'empty';
    out.textContent = r.error || 'No response';
    return;
  }
  meta.className = 'hint' + (r.status >= 400 ? ' bad' : '');
  meta.textContent = `${line} → HTTP ${r.status} · ${r.ms} ms · ${r.headers?.['content-type'] || 'no content-type'}${r.truncated ? ' · truncated' : ''}`;
  let body = r.body;
  try { body = JSON.stringify(JSON.parse(r.body), null, 2); } catch { /* not JSON: show as is */ }
  out.className = body ? '' : 'empty';
  out.textContent = body || '(empty body)';
}

async function sendRequest(spec) {
  const sub = state.sub;
  if (!sub || !state.nodeEntry) return;
  state.testRow = null;
  renderTests();
  $('#reqMeta').className = 'hint';
  $('#reqMeta').textContent = 'Sending…';
  const r = await appPost('/request', spec).catch((e) => ({ error: e.message }));
  if (sub !== state.sub) return;
  if (r.app) { state.app = r.app; renderApp(); }
  showResponse(spec, r);
}

$('#testBtn').onclick = () => runTests();
$('#restartBtn').onclick = () => restartApp();
// A test row shows the response it already got; it is not sent again (that would change the server's state)
$('#testResults').onclick = (e) => {
  const tr = e.target.closest('tr[data-i]');
  const r = state.tests?.results?.[tr?.dataset.i];
  if (!r) return;
  state.testRow = Number(tr.dataset.i);
  renderTests();
  showResponse(r, r);
};
$('#reqForm').onsubmit = (e) => {
  e.preventDefault();
  const method = $('#reqMethod').value;
  const body = $('#reqBody').value.trim();
  sendRequest({ method, path: $('#reqPath').value.trim() || '/', body: body && method !== 'GET' ? body : undefined });
};
for (const el of ['#reqPath', '#reqBody']) $(el).onkeydown = (e) => { if (e.key === 'Escape') e.target.blur(); };
$('#reqBody').onkeydown = (e) => {
  if (e.key === 'Escape') e.target.blur();
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#reqForm').requestSubmit(); }
};

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

loadStatus().then(() => loadAssignments());
