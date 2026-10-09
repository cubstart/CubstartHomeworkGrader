const $ = (s) => document.querySelector(s);
const state = { assignment: null, subs: [], sub: null, files: [], entry: null, file: null, port: null };

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

function renderSubs() {
  $('#subList').innerHTML = visibleSubs().map((s) => {
    const tip = s.error || [s.email, s.graded && `Graded by ${s.gradedBy || '?'} ${s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ''}`].filter(Boolean).join('\n') || s.name;
    return `<li data-id="${esc(s.id)}" class="${s.id === state.sub?.id ? 'active' : ''} ${s.error ? 'err' : ''} ${s.graded ? 'graded' : ''}" title="${esc(tip)}"><span class="check">${s.graded ? '✓' : ''}</span>${esc(s.name)}</li>`;
  }).join('');
  const graded = state.subs.filter((s) => s.graded).length;
  $('#gradedCount').textContent = state.dbOk && state.subs.length ? `${graded} / ${state.subs.length} graded` : '';
  $('#gradeBtn').hidden = !state.dbOk || !state.sub;
  $('#gradeBtn').textContent = state.sub?.graded ? '✓ Graded' : 'Mark as graded';
  $('#gradeBtn').title = state.sub?.graded ? `Graded by ${state.sub.gradedBy || '?'}. Click (or press g) to undo` : 'Click or press g';
  $('#gradeBtn').classList.toggle('done', !!state.sub?.graded);
}

$('#filter').oninput = renderSubs;
$('#hideGraded').onchange = renderSubs;

// ---------- Grading status ----------

async function toggleGraded(sub = state.sub) {
  if (!sub || !state.dbOk) return;
  const prev = { graded: sub.graded, gradedBy: sub.gradedBy, updatedAt: sub.updatedAt };
  sub.graded = !sub.graded; // optimistic; reverted below if the save fails
  renderSubs();
  try {
    const r = await fetch(`/api/assignments/${encodeURIComponent(state.assignment)}/${encodeURIComponent(sub.id)}/grade`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ graded: sub.graded }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    Object.assign(sub, body);
  } catch (e) {
    Object.assign(sub, prev);
    alert(`Could not save grading status: ${e.message}`);
  }
  renderSubs();
}

$('#gradeBtn').onclick = () => toggleGraded();

// Pick up other graders' changes
setInterval(async () => {
  if (!state.dbOk || !state.assignment || document.hidden) return;
  const aid = state.assignment;
  const grades = await api(`/api/assignments/${encodeURIComponent(aid)}/grades`).catch(() => null);
  if (!grades || grades.error || aid !== state.assignment) return;
  for (const s of state.subs) Object.assign(s, { graded: false, gradedBy: undefined, updatedAt: undefined }, grades[s.id]);
  renderSubs();
}, 10000);
$('#subList').onclick = (e) => { const li = e.target.closest('li'); if (li) selectSub(li.dataset.id); };

async function selectSub(id) {
  state.sub = state.subs.find((s) => s.id === id);
  renderSubs();
  const { files, entry, port } = await api(`/api/assignments/${state.assignment}/${id}/files`);
  state.port = port;
  state.files = files;
  state.entry = entry;
  renderTree();
  showPreview();
  openFile(entry || files[0]?.path || null, false);
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
}
document.querySelectorAll('.tabs button[data-tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

function showPreview(switchTab = true) {
  const has = !!state.entry;
  $('#frame').hidden = !has;
  $('#noPreview').hidden = has;
  $('#openTab').hidden = !has;
  if (has) {
    const u = fileUrl(state.entry);
    $('#frame').src = u;
    $('#openTab').href = u;
    $('#current').textContent = state.entry;
  } else {
    $('#frame').src = 'about:blank';
    $('#current').textContent = '';
  }
  if (switchTab) setTab(has ? 'preview' : 'source');
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
  if (e.key !== 'j' && e.key !== 'k') return;
  const list = visibleSubs();
  const i = list.findIndex((s) => s.id === state.sub?.id);
  const next = list[i + (e.key === 'j' ? 1 : -1)];
  if (next) selectSub(next.id);
});

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

loadStatus().then(() => loadAssignments());
