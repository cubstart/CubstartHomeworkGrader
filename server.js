const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');
const { MongoClient } = require('mongodb');
const nodeApps = require('./node-apps');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env file */ }

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

const newBudget = () => ({ bytes: MAX_UNZIPPED_BYTES, entries: MAX_ZIP_ENTRIES });

function writeEntry(destDir, name, entry, depth, budget) {
  if (IGNORED.test(name)) return;
  const out = path.resolve(destDir, name);
  if (!out.startsWith(path.resolve(destDir) + path.sep)) return; // zip-slip guard
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
      return;
    } catch (e) {
      if (e instanceof ZipLimitError) throw e;
      /* not a valid zip, keep it as a file */
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
}

function extractZip(buf, destDir, depth = 0, budget = newBudget()) {
  for (const entry of new AdmZip(buf).getEntries()) {
    if (!entry.isDirectory) writeEntry(destDir, entry.entryName.replace(/\\/g, '/'), entry, depth, budget);
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

  // An export is the full set of submissions, so replace whatever was imported before.
  // Running student servers for it are stopped first: their folders are about to go.
  const assignDir = path.join(DATA_DIR, assignmentId);
  await nodeApps.stopApps(`${assignmentId}/`);
  fs.rmSync(assignDir, { recursive: true, force: true });
  fs.mkdirSync(assignDir, { recursive: true });
  const manifest = { assignmentId, source: filename, importedAt: new Date().toISOString(), submissions: {} };

  job.total = subs.length;
  job.log(`Found ${subs.length} submission(s) for assignment ${assignmentId}`);

  for (const s of subs) {
    const { files, ...info } = s;
    const dir = path.join(assignDir, s.id);
    try {
      if (!files.length) throw new Error('No files in this submission');
      const budget = newBudget();
      for (const f of files) writeEntry(dir, f.name, f.entry, 0, budget);
      manifest.submissions[s.id] = info;
      job.log(`✓ ${s.name}`);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true }); // don't leave half a submission behind
      manifest.submissions[s.id] = { ...info, error: e.message };
      job.log(`✗ ${s.name}: ${e.message}`);
    }
    job.done++;
    await new Promise(setImmediate); // let progress polls through
  }
  fs.writeFileSync(path.join(assignDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return assignmentId;
}

// ---------- Grading status (MongoDB) ----------

// Lives in MongoDB rather than data/ so every grader sees the same status. Set in .env:
//   MONGODB_URI  connection string (required to enable grading status)
//   MONGODB_DB   database name, default "cubstart-grader"
//   GRADER_NAME  who is recorded as the grader, default your OS username
const GRADER = process.env.GRADER_NAME || os.userInfo().username;
const db = { client: null, grades: null, status: process.env.MONGODB_URI ? 'connecting' : 'not configured', error: null };

// Single-choice rubric, the same for every assignment. Picking an item marks the submission
// graded with that score; the label is copied onto the grade so it survives edits to this list.
const RUBRIC = [
  { points: 5, label: 'Uses all required elements' },
  { points: 4, label: 'Uses most required elements' },
  { points: 2, label: 'Uses some required elements' },
  { points: 0, label: 'No work' },
];
const MAX_SCORE = Math.max(...RUBRIC.map((r) => r.points));
const MAX_COMMENT = 5000;

// Grade fields sent to the UI (not _id, name or email: the manifest already has those)
const GRADE_FIELDS = { _id: 0, submissionId: 1, graded: 1, score: 1, maxScore: 1, rubric: 1, comment: 1, gradedBy: 1, updatedAt: 1 };

async function connectDb() {
  if (!process.env.MONGODB_URI) return;
  db.status = 'connecting';
  try {
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, appName: 'cubstart-grader' });
    await client.connect();
    const grades = client.db(process.env.MONGODB_DB || 'cubstart-grader').collection('grades');
    await grades.createIndex({ assignmentId: 1, submissionId: 1 }, { unique: true });
    Object.assign(db, { client, grades, status: 'connected', error: null });
    console.log('MongoDB: connected');
  } catch (e) {
    Object.assign(db, { status: 'error', error: e.message });
    console.error(`MongoDB: ${e.message} (retrying in 30s)`);
    setTimeout(connectDb, 30000).unref();
  }
}

function requireDb(req, res, next) {
  if (db.grades) return next();
  res.status(503).json({ error: db.error ? `MongoDB: ${db.error}` : 'Grading status needs MONGODB_URI in .env' });
}

// { submissionId: { graded, score, maxScore, rubric, comment, gradedBy, updatedAt } } for one assignment
async function gradesFor(aid) {
  const docs = await db.grades.find({ assignmentId: aid }, { projection: GRADE_FIELDS }).toArray();
  return Object.fromEntries(docs.map(({ submissionId, ...g }) => [submissionId, g]));
}

function readManifest(aid) {
  const mp = path.join(DATA_DIR, path.basename(aid), 'manifest.json');
  return fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : null;
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

// Student pages often reference assets with paths that only worked on their own setup: root-
// absolute ("/assets/x.jpg" while index.html sits in HW1/), GitHub Pages style
// ("/repo-name/HW1/assets/x.jpg"), or the wrong letter case. When express.static finds nothing,
// this looks for the file relative to the entry HTML's folder, then by unique path suffix,
// ignoring case. Only files that exist inside the submission can match, so nothing escapes it.
function looseResolver(dir) {
  let index = null;
  const build = () => {
    const files = walk(dir);
    const entry = findEntryHtml(files) || '';
    const paths = files.map((f) => f.path);
    return { paths, entryDir: entry.slice(0, entry.lastIndexOf('/') + 1), lower: new Map(paths.map((p) => [p.toLowerCase(), p])) };
  };
  return (reqPath) => {
    let p;
    try { p = decodeURIComponent(reqPath).replace(/^[/]+/, ''); } catch { return null; }
    if (!p) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      index ||= build();
      const { paths, entryDir, lower } = index;
      let hit = lower.get((entryDir + p).toLowerCase()) || lower.get(p.toLowerCase());
      // Drop leading folders until exactly one file ends with what is left
      const parts = p.toLowerCase().split('/');
      for (let i = 1; i < parts.length && !hit; i++) {
        const tail = '/' + parts.slice(i).join('/');
        const found = paths.filter((f) => ('/' + f.toLowerCase()).endsWith(tail));
        if (found.length === 1) hit = found[0];
        else if (found.length > 1) break;
      }
      if (!hit) return null;
      const abs = path.join(dir, hit);
      if (fs.existsSync(abs)) return abs;
      index = null; // the files changed since indexing (re-import); rebuild once
    }
    return null;
  };
}

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
  const resolve = looseResolver(dir);
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let file = null;
    try { file = resolve(req.path); } catch { /* unreadable submission dir: fall through to 404 */ }
    if (!file) return next();
    res.sendFile(file, { dotfiles: 'allow' });
  });
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
// A cross-site page can send a form POST without a CORS preflight; requiring JSON (or zip,
// also not a "simple" type) forces a preflight, which fails because this server sends no CORS headers
app.use((req, res, next) => (['GET', 'HEAD'].includes(req.method) || req.is('application/json') || req.is('application/zip') ? next() : res.status(415).end()));
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/status', (req, res) => {
  res.json({ db: db.status, dbError: db.error, grader: GRADER, rubric: RUBRIC });
});

app.post('/api/import', express.raw({ type: 'application/zip', limit: '1gb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty upload' });
  const filename = path.basename(decodeURIComponent(req.get('X-Filename') || 'upload.zip'));
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

app.get('/api/assignments/:aid', async (req, res) => {
  const m = readManifest(req.params.aid);
  if (!m) return res.status(404).end();
  // The submission list still loads if MongoDB is down; it just has no grading status
  const grades = db.grades ? await gradesFor(m.assignmentId).catch(() => ({})) : {};
  const subs = Object.values(m.submissions)
    .map((s) => ({ ...s, graded: false, ...grades[s.id] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ...m, submissions: subs });
});

// Polled by the UI so other graders' changes show up
app.get('/api/assignments/:aid/grades', requireDb, async (req, res) => {
  try { res.json(await gradesFor(path.basename(req.params.aid))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// The body is a patch holding any of:
//   { rubric: <index into RUBRIC> }   grade with that item's score
//   { graded: true | false }          mark graded without a score / clear the grade (the comment stays)
//   { comment: "..." }                set the comment; an empty string removes it
// Responds with the saved grade fields (GRADE_FIELDS).
app.put('/api/assignments/:aid/:sid/grade', requireDb, async (req, res) => {
  const m = readManifest(req.params.aid);
  const s = m?.submissions[req.params.sid];
  if (!s) return res.status(404).json({ error: 'Unknown submission' });
  const { rubric, graded, comment } = req.body || {};
  const set = { gradedBy: GRADER, updatedAt: new Date(), name: s.name, email: s.email };
  const unset = {};
  let changed = false;
  if (rubric !== undefined) {
    if (!Number.isInteger(rubric) || !RUBRIC[rubric]) return res.status(400).json({ error: `"rubric" must be a whole number from 0 to ${RUBRIC.length - 1}` });
    Object.assign(set, { graded: true, score: RUBRIC[rubric].points, maxScore: MAX_SCORE, rubric: RUBRIC[rubric].label });
    changed = true;
  } else if (graded !== undefined) {
    if (typeof graded !== 'boolean') return res.status(400).json({ error: '"graded" must be true or false' });
    // The score goes either way: ungrading clears it, and grading without a rubric item must not
    // bring back a score that an older client left behind when it ungraded
    set.graded = graded;
    Object.assign(unset, { score: '', maxScore: '', rubric: '' });
    changed = true;
  }
  if (comment !== undefined) {
    if (typeof comment !== 'string') return res.status(400).json({ error: '"comment" must be a string' });
    if (comment.length > MAX_COMMENT) return res.status(400).json({ error: `Comment is longer than ${MAX_COMMENT} characters` });
    const text = comment.trim();
    if (text) set.comment = text; else unset.comment = '';
    changed = true;
  }
  if (!changed) return res.status(400).json({ error: 'Nothing to update: send "rubric", "graded" or "comment"' });
  const onInsert = { assignmentId: m.assignmentId, submissionId: s.id };
  if (set.graded === undefined) onInsert.graded = false; // a comment alone does not grade
  const update = { $set: set, $setOnInsert: onInsert };
  if (Object.keys(unset).length) update.$unset = unset;
  try {
    const doc = await db.grades.findOneAndUpdate(
      { assignmentId: m.assignmentId, submissionId: s.id },
      update,
      { upsert: true, returnDocument: 'after', projection: GRADE_FIELDS },
    );
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/assignments/:aid/:sid/files', async (req, res) => {
  const aid = path.basename(req.params.aid);
  const sid = path.basename(req.params.sid);
  const dir = path.join(DATA_DIR, aid, sid);
  if (!fs.existsSync(dir)) return res.json({ files: [], entry: null, nodeEntry: null, port: null, app: null });
  try {
    const files = walk(dir);
    // A submission with a Node server file also gets that server started (app), on top of the
    // static port the Source tab reads files from
    const nodeEntry = nodeApps.findEntryJs(files, dir);
    const app = nodeEntry ? nodeApps.appInfo(nodeApps.getApp(`${aid}/${sid}`, dir, nodeEntry)) : null;
    res.json({ files, entry: findEntryHtml(files), nodeEntry, port: await previewPort(aid, sid), app });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Student Node.js servers ----------

// Resolves the submission folder and its server file for the routes below, or responds 404
function nodeSub(req, res) {
  const aid = path.basename(req.params.aid);
  const sid = path.basename(req.params.sid);
  const dir = path.join(DATA_DIR, aid, sid);
  if (!fs.existsSync(dir)) { res.status(404).json({ error: 'Unknown submission' }); return null; }
  const entry = nodeApps.findEntryJs(walk(dir), dir);
  if (!entry) { res.status(404).json({ error: 'This submission has no Node.js server file' }); return null; }
  return { key: `${aid}/${sid}`, dir, entry };
}

// Status and console output; starts the server if it isn't running
app.get('/api/assignments/:aid/:sid/app', (req, res) => {
  const s = nodeSub(req, res);
  if (s) res.json(nodeApps.appInfo(nodeApps.getApp(s.key, s.dir, s.entry)));
});

app.post('/api/assignments/:aid/:sid/app/restart', async (req, res) => {
  const s = nodeSub(req, res);
  if (!s) return;
  const rec = nodeApps.getApp(s.key, s.dir, s.entry, true);
  await rec.ready;
  res.json(nodeApps.appInfo(rec));
});

// Proxies one request from the grader to the student server. Body: { method, path, headers?, body? }
// (body is the raw string). Responds with the result of the request plus the app's status.
app.post('/api/assignments/:aid/:sid/app/request', async (req, res) => {
  const s = nodeSub(req, res);
  if (!s) return;
  const spec = { method: 'GET', path: '/', ...(req.body || {}) };
  const bad = nodeApps.validateRequest(spec);
  if (bad) return res.status(400).json({ error: bad });
  const rec = nodeApps.getApp(s.key, s.dir, s.entry);
  await rec.ready;
  const result = await nodeApps.appRequest(rec, spec);
  res.json({ ...result, app: nodeApps.appInfo(rec) });
});

// Runs the assignment's Postman-style checks against a fresh server (restarted unless it was
// just started and has had no requests yet). Responds { name, results: [...], app }.
app.post('/api/assignments/:aid/:sid/app/test', async (req, res) => {
  const s = nodeSub(req, res);
  if (!s) return;
  let rec = nodeApps.getApp(s.key, s.dir, s.entry);
  await rec.ready;
  if (rec.status !== 'running' || rec.requests > 0) { rec = nodeApps.getApp(s.key, s.dir, s.entry, true); await rec.ready; }
  const results = rec.status === 'running' ? await nodeApps.runTests(rec) : [];
  res.json({ name: nodeApps.API_TESTS.name, results, app: nodeApps.appInfo(rec) });
});

listenLoopback(app, PORT)
  .then(() => console.log(`Grader UI: http://localhost:${PORT}`))
  .catch((e) => { console.error(`Could not start on port ${PORT}: ${e.message}`); process.exit(1); });

connectDb();

process.on('SIGINT', async () => { await db.client?.close().catch(() => {}); process.exit(0); });
