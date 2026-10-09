const express = require('express');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');

const PORT = Number(process.env.PORT) || 3000;
const FILES_PORT = PORT + 1; // student code is served from a separate origin so it can't touch the app's API
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Unzipping ----------

const IGNORED = /(^|\/)(__MACOSX|\.DS_Store|node_modules|\.git)(\/|$)/;

function writeEntry(destDir, name, data, depth) {
  const out = path.resolve(destDir, name);
  if (!out.startsWith(path.resolve(destDir) + path.sep)) return; // zip-slip guard
  // Students often upload a zip of their project; unpack nested zips in place
  if (depth < 3 && /\.zip$/i.test(name)) {
    try {
      extractZip(data, out.replace(/\.zip$/i, ''), depth + 1);
      return;
    } catch { /* not a valid zip, keep it as a file */ }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
}

function extractZip(buf, destDir, depth = 0) {
  for (const entry of new AdmZip(buf).getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (entry.isDirectory || IGNORED.test(name)) continue;
    writeEntry(destDir, name, entry.getData(), depth);
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

// ---------- App ----------

const app = express();
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/status', (req, res) => {
  res.json({ filesOrigin: `http://localhost:${FILES_PORT}` });
});

app.post('/api/import', express.raw({ type: () => true, limit: '1gb' }), (req, res) => {
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

app.get('/api/assignments/:aid', (req, res) => {
  const mp = path.join(DATA_DIR, path.basename(req.params.aid), 'manifest.json');
  if (!fs.existsSync(mp)) return res.status(404).end();
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const subs = Object.values(m.submissions).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ...m, submissions: subs });
});

app.get('/api/assignments/:aid/:sid/files', (req, res) => {
  const dir = path.join(DATA_DIR, path.basename(req.params.aid), path.basename(req.params.sid));
  if (!fs.existsSync(dir)) return res.json({ files: [], entry: null });
  const files = walk(dir);
  res.json({ files, entry: findEntryHtml(files) });
});

app.listen(PORT, () => console.log(`Grader UI:      http://localhost:${PORT}`));

// Raw student files (HTML/JS/CSS/assets), served on a different origin
const files = express();
files.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });
files.use(express.static(DATA_DIR, { dotfiles: 'allow' }));
files.listen(FILES_PORT, () => console.log(`Student files:  http://localhost:${FILES_PORT}`));
