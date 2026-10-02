const $ = (s) => document.querySelector(s);
const state = { filesOrigin: '', assignment: null, subs: [], sub: null, files: [], entry: null, file: null };

const IMG = /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/i;
const MEDIA = /\.(mp4|webm|mov|mp3|wav|ogg)$/i;
const BINARY = /\.(pdf|zip|woff2?|ttf|otf|eot)$/i;
const LANG = { js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', css: 'css', html: 'xml', htm: 'xml', json: 'json', md: 'markdown', py: 'python', svg: 'xml' };

const fileUrl = (p) => `${state.filesOrigin}/${state.assignment}/${state.sub.id}/${p.split('/').map(encodeURIComponent).join('/')}`;
const api = (p, opts) => fetch(p, opts).then((r) => r.json());

// ---------- Login ----------

async function refreshStatus() {
  const s = await api('/api/status');
  state.filesOrigin = s.filesOrigin;
  const el = $('#loginStatus');
  el.textContent = s.loggedIn ? 'Logged in' : 'Not logged in';
  el.className = 'pill ' + (s.loggedIn ? 'ok' : 'bad');
  return s.loggedIn;
}

$('#loginBtn').onclick = async () => {
  await api('/api/login', { method: 'POST' });
  $('#loginStatus').textContent = 'Log in in the Chromium window…';
  const t = setInterval(async () => { if (await refreshStatus()) clearInterval(t); }, 3000);
};

// ---------- Fetching ----------

$('#fetchBtn').onclick = async () => {
  const url = $('#url').value.trim();
  if (!url) return;
  $('#fetchBtn').disabled = true;
  $('#progress').hidden = false;
  $('#log').textContent = '';
  const { jobId } = await api('/api/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  const t = setInterval(async () => {
    const j = await api(`/api/jobs/${jobId}`);
    $('#barFill').style.width = j.total ? `${(100 * j.done) / j.total}%` : '0';
    $('#log').textContent = j.logs.join('\n');
    $('#log').scrollTop = 1e9;
    if (j.status !== 'running') {
      clearInterval(t);
      $('#fetchBtn').disabled = false;
      if (j.assignmentId) await loadAssignments(j.assignmentId);
    }
  }, 1000);
};

// ---------- Assignments & submissions ----------

async function loadAssignments(select) {
  const list = await api('/api/assignments');
  $('#assignment').innerHTML = list.length
    ? list.map((a) => `<option value="${a.assignmentId}">Assignment ${a.assignmentId} (${a.count})</option>`).join('')
    : '<option>No assignments fetched yet</option>';
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
  if (a.url && !$('#url').value) $('#url').value = a.url;
  state.subs = a.submissions;
  renderSubs();
  if (state.subs.length) selectSub(state.subs[0].id);
}

function visibleSubs() {
  const q = $('#filter').value.toLowerCase();
  return state.subs.filter((s) => `${s.name} ${s.email || ''}`.toLowerCase().includes(q));
}

function renderSubs() {
  $('#subList').innerHTML = visibleSubs().map((s) =>
    `<li data-id="${s.id}" class="${s.id === state.sub?.id ? 'active' : ''} ${s.error ? 'err' : ''}" title="${esc(s.error || s.email || s.name)}">${esc(s.name)}</li>`
  ).join('');
}

$('#filter').oninput = renderSubs;
$('#subList').onclick = (e) => { const li = e.target.closest('li'); if (li) selectSub(li.dataset.id); };

async function selectSub(id) {
  state.sub = state.subs.find((s) => s.id === id);
  renderSubs();
  const { files, entry } = await api(`/api/assignments/${state.assignment}/${id}/files`);
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
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#previewPane').hidden = tab !== 'preview';
  $('#sourcePane').hidden = tab !== 'source';
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

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
  if (e.key !== 'j' && e.key !== 'k') return;
  const list = visibleSubs();
  const i = list.findIndex((s) => s.id === state.sub?.id);
  const next = list[i + (e.key === 'j' ? 1 : -1)];
  if (next) selectSub(next.id);
});

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

refreshStatus().then(() => loadAssignments());
