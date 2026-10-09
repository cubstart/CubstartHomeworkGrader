const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Unzipping ----------

const IGNORED = /(^|\/)(__MACOSX|\.DS_Store|node_modules|\.git)(\/|$)/;

// Zip-bomb limits per submission, shared across nested zips
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
class ZipLimitError extends Error {}

function extractZip(buf, destDir, depth = 0, budget = { bytes: MAX_UNZIPPED_BYTES, entries: MAX_ZIP_ENTRIES }) {
  const zip = new AdmZip(buf);
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (entry.isDirectory || IGNORED.test(name)) continue;
    const out = path.resolve(destDir, name);
    if (!out.startsWith(path.resolve(destDir) + path.sep)) continue; // zip-slip guard
    if (--budget.entries < 0) throw new ZipLimitError(`Submission has more than ${MAX_ZIP_ENTRIES} files`);
    // Check the declared size before inflating, then the real one (headers can lie)
    const tooBig = () => new ZipLimitError(`Submission is larger than ${MAX_UNZIPPED_BYTES / 1024 / 1024} MB unzipped`);
    if (entry.header.size > budget.bytes) throw tooBig();
    const data = entry.getData();
    if ((budget.bytes -= data.length) < 0) throw tooBig();
    // Students often upload a zip of their project; unpack nested zips in place
    if (depth < 3 && /\.zip$/i.test(name)) {
      try {
        extractZip(data, out.replace(/\.zip$/i, ''), depth + 1, budget);
        continue;
      } catch (e) {
        if (e instanceof ZipLimitError) throw e;
        /* not a valid zip, keep it as a file */
      }
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
}

function walk(dir, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walk(path.join(dir, ent.name), r));
    else out.push({ path: r, size: fs.statSync(path.join(dir, ent.name)).size });
  }
  return out;
}

function findEntryHtml(files) {
  const html = files.filter((f) => /\.html?$/i.test(f.path));
  const depth = (p) => p.split('/').length;
  html.sort((a, b) => {
    const ai = /(^|\/)index\.html?$/i.test(a.path) ? 0 : 1;
    const bi = /(^|\/)index\.html?$/i.test(b.path) ? 0 : 1;
    return ai - bi || depth(a.path) - depth(b.path);
  });
  return html[0]?.path || null;
}

// ---------- Gradescope export ----------

// Gradescope's "Export Submissions" zip looks like:
//   assignment_<aid>_export/submission_metadata.yml
//   assignment_<aid>_export/submission_<sid>/<whatever the student uploaded>
function parseExport(buf, filename) {
  const entries = new AdmZip(buf).getEntries()
    .map((entry) => ({ name: entry.entryName.replace(/\\/g, '/'), entry }))
    .filter((e) => !e.entry.isDirectory && !/(^|\/)__MACOSX\//.test(e.name));

  // The folder holding submission_* dirs (usually assignment_<aid>_export/, but tolerate re-zipped exports)
  const first = entries.map((e) => e.name.match(/^(.*?)submission_\d+\//)).find(Boolean);
  if (!first) throw new Error('No submission_<id>/ folders found. Is this a Gradescope "Export Submissions" zip?');
  const prefix = first[1];

  const assignmentId = (prefix.match(/assignment_(\d+)_export/) || filename.match(/assignment_(\d+)_export/) || [])[1]
    || path.basename(filename, path.extname(filename)).replace(/[^\w-]/g, '_') || 'import';

  const subs = new Map();
  const get = (id) => subs.get(id) || subs.set(id, { id, name: `Submission ${id}`, email: null, files: [] }).get(id);

  // submitters[] holds every group member
  const metaEntry = entries.find((e) => e.name === `${prefix}submission_metadata.yml`);
  let metaError = null;
  if (metaEntry) {
    try {
      const meta = yaml.load(metaEntry.entry.getData().toString('utf8')) || {};
      for (const [key, m] of Object.entries(meta)) {
        const id = (key.match(/^submission_(\d+)$/) || [])[1];
        const people = m?.[':submitters'] || [];
        if (!id || !people.length) continue;
        const s = get(id);
        s.name = people.map((p) => p[':name']).filter(Boolean).join(', ') || s.name;
        s.email = people.map((p) => p[':email']).filter(Boolean).join(', ') || null;
        s.submittedAt = m[':created_at'] ? new Date(m[':created_at']).toISOString() : null;
      }
    } catch (e) { metaError = e.message; }
  }

  for (const e of entries) {
    if (!e.name.startsWith(prefix)) continue;
    const m = e.name.slice(prefix.length).match(/^submission_(\d+)\/(.+)$/);
    if (m) get(m[1]).files.push({ name: m[2], entry: e.entry });
  }

  return { assignmentId, subs: [...subs.values()], hasMeta: !!metaEntry, metaError };
}

// ---------- Jobs ----------

const jobs = new Map();

async function runImport(job, buf, filename) {
  job.log(`Reading ${filename}…`);
  const { assignmentId, subs, hasMeta, metaError } = parseExport(buf, filename);
  if (!hasMeta) job.log('No submission_metadata.yml found; students will be listed by submission id');
  if (metaError) job.log(`Could not read submission_metadata.yml (${metaError}); students will be listed by submission id`);

  // An export is the full set of submissions, so replace whatever was imported before
  const assignDir = path.join(DATA_DIR, assignmentId);
  fs.rmSync(assignDir, { recursive: true, force: true });
  fs.mkdirSync(assignDir, { recursive: true });
  const manifest = { assignmentId, source: filename, importedAt: new Date().toISOString(), submissions: {} };

  job.total = subs.length;
  job.log(`Found ${subs.length} submission(s) for assignment ${assignmentId}`);

  for (const s of subs) {
    const { files, ...info } = s;
    try {
      if (!files.length) throw new Error('No files in this submission');
      const dir = path.join(assignDir, s.id);
      for (const f of files) if (!IGNORED.test(f.name)) writeEntry(dir, f.name, f.entry.getData(), 0);
      manifest.submissions[s.id] = info;
      job.log(`✓ ${s.name}`);
    } catch (e) {
      manifest.submissions[s.id] = { ...info, error: e.message };
      job.log(`✗ ${s.name}: ${e.message}`);
    }
    job.done++;
    await new Promise(setImmediate); // let progress polls through
  }
  fs.writeFileSync(path.join(assignDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return assignmentId;
}

// ---------- Network guards ----------

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const APP_ORIGINS = new Set(LOOPBACK_HOSTS.map((h) => `http://${h}:${PORT}`));

// IPv4 (any 127.x), IPv6, and IPv4-mapped IPv6 (::ffff:127.0.0.1) loopback addresses
const isLoopback = (addr = '') => addr === '::1' || /^(::ffff:)?127\./.test(addr);

// Only this machine may connect, and only under a loopback hostname. The Host check stops
// DNS rebinding, where a website points its own domain at 127.0.0.1 to read our responses.
function localOnly(req, res, next) {
  const port = req.socket.localPort;
  const host = String(req.headers.host || '').toLowerCase();
  if (!isLoopback(req.socket.remoteAddress) || !LOOPBACK_HOSTS.some((h) => host === `${h}:${port}`)) {
    return res.status(403).send('Forbidden');
  }
  next();
}

// Binds the IPv4 and IPv6 loopback addresses so "localhost" works whichever one the OS
// resolves it to. Never binds a network-facing address. IPv6 is optional: machines without
// it keep the IPv4 listener, and browsers fall back to it.
function listenLoopback(handler, port) {
  return new Promise((resolve, reject) => {
    const v4 = http.createServer(handler);
    v4.once('error', reject);
    v4.listen(port, '127.0.0.1', () => {
      const actual = v4.address().port;
      const v6 = http.createServer(handler);
      v6.once('error', () => resolve({ port: actual, servers: [v4] }));
      v6.listen(actual, '::1', () => resolve({ port: actual, servers: [v4, v6] }));
    });
  });
}

// ---------- Preview servers ----------

// Each submission is served on its own loopback port, i.e. its own browser origin, so student
// code can't read other submissions, and its localStorage stays separate from theirs.
const MAX_PREVIEWS = 50;
const previews = new Map(); // "aid/sid" -> Promise<{ port, servers }>, oldest first

function previewApp(dir) {
  const app = express();
  app.use(localOnly);
  app.use((req, res, next) => {
    // A service worker outlives the preview and could rewrite what the grader sees
    if (req.get('Service-Worker')) return res.status(403).end();
    // Only the grader UI may read files cross-origin (for the Source tab)
    const origin = req.get('Origin');
    if (APP_ORIGINS.has(origin)) res.set('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
    next();
  });
  app.use(express.static(dir, { dotfiles: 'allow' }));
  return app;
}

function previewPort(aid, sid) {
  const key = `${aid}/${sid}`;
  let p = previews.get(key);
  if (p) previews.delete(key); // re-inserted below as most recently used
  else {
    p = listenLoopback(previewApp(path.join(DATA_DIR, aid, sid)), 0);
    p.catch(() => { if (previews.get(key) === p) previews.delete(key); });
  }
  previews.set(key, p);
  if (previews.size > MAX_PREVIEWS) {
    const [oldKey, old] = previews.entries().next().value;
    previews.delete(oldKey);
    old.then(({ servers }) => servers.forEach((s) => { s.close(); s.closeAllConnections(); })).catch(() => {});
  }
  return p.then((r) => r.port);
}

// ---------- App ----------

const app = express();
app.use(localOnly);
// A cross-site page can send a form POST without a CORS preflight; requiring JSON forces
// a preflight, which fails because this server sends no CORS headers
app.use((req, res, next) => (['GET', 'HEAD'].includes(req.method) || req.is('application/json') ? next() : res.status(415).end()));
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/status', async (req, res) => {
  try { res.json({ loggedIn: await isLoggedIn() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const ctx = await getContext({ headed: true });
    const page = await ctx.newPage();
    await page.goto(`${GS}/login`);
    await page.bringToFront();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fetch', (req, res) => {
  const id = String(Date.now());
  const job = { id, status: 'running', total: 0, done: 0, logs: [], assignmentId: null };
  job.log = (m) => job.logs.push(m);
  jobs.set(id, job);
  runImport(job, req.body, filename)
    .then((a) => { job.assignmentId = a; job.status = 'done'; })
    .catch((e) => { job.status = 'error'; job.log(`Error: ${e.message}`); });
  res.json({ jobId: id });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  const { log, ...rest } = job;
  res.json(rest);
});

app.get('/api/assignments', (req, res) => {
  const list = fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(DATA_DIR, d.name, 'manifest.json')))
    .map((d) => {
      const m = JSON.parse(fs.readFileSync(path.join(DATA_DIR, d.name, 'manifest.json'), 'utf8'));
      return { assignmentId: m.assignmentId, source: m.source, count: Object.keys(m.submissions).length };
    });
  res.json(list);
});

app.get('/api/assignments/:aid', (req, res) => {
  const mp = path.join(DATA_DIR, path.basename(req.params.aid), 'manifest.json');
  if (!fs.existsSync(mp)) return res.status(404).end();
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const subs = Object.values(m.submissions).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ...m, submissions: subs });
});

app.get('/api/assignments/:aid/:sid/files', async (req, res) => {
  const aid = path.basename(req.params.aid);
  const sid = path.basename(req.params.sid);
  const dir = path.join(DATA_DIR, aid, sid);
  if (!fs.existsSync(dir)) return res.json({ files: [], entry: null, port: null });
  try {
    const files = walk(dir);
    res.json({ files, entry: findEntryHtml(files), port: await previewPort(aid, sid) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

listenLoopback(app, PORT)
  .then(() => console.log(`Grader UI: http://localhost:${PORT}`))
  .catch((e) => { console.error(`Could not start on port ${PORT}: ${e.message}`); process.exit(1); });

process.on('SIGINT', async () => { if (context) await context.close().catch(() => {}); process.exit(0); });
