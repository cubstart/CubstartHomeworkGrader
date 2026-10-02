const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PROFILE_DIR = path.join(ROOT, '.gradescope-profile');
const GS = 'https://www.gradescope.com';
const CONCURRENCY = 4;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Playwright session ----------

let context = null;
let contextHeaded = false;
let launching = null; // serialize launches; a persistent profile can only be open once

function getContext({ headed = false } = {}) {
  if (context && (!headed || contextHeaded)) return Promise.resolve(context);
  if (launching) return launching.then(() => getContext({ headed }));
  launching = (async () => {
    if (context) await context.close().catch(() => {});
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: !headed, acceptDownloads: true });
    ctx.on('close', () => { if (context === ctx) context = null; });
    context = ctx;
    contextHeaded = headed;
    return ctx;
  })().finally(() => { launching = null; });
  return launching;
}

async function isLoggedIn() {
  const ctx = await getContext();
  const res = await ctx.request.get(`${GS}/account`, { maxRedirects: 0 }).catch(() => null);
  return !!res && res.status() === 200;
}

// ---------- URL parsing ----------

// Accepts any of:
//   /courses/C/assignments/A[/grade|/review_grades|/submissions/S]
//   /courses/C/questions/Q/submissions[/QS/grade]   (question-level grading pages)
function parseGradescopeUrl(raw) {
  const u = new URL(raw);
  if (!/(^|\.)gradescope\.com$/.test(u.hostname)) throw new Error('Not a gradescope.com URL');
  let m = u.pathname.match(/\/courses\/(\d+)\/questions\/(\d+)(?:\/submissions\/(\d+))?/);
  if (m) return { courseId: m[1], questionId: m[2], questionSubmissionId: m[3] || null };
  m = u.pathname.match(/\/courses\/(\d+)\/assignments\/(\d+)(?:\/submissions\/(\d+))?/);
  if (m) return { courseId: m[1], assignmentId: m[2], submissionId: m[3] || null };
  throw new Error('URL must look like /courses/<id>/assignments/<id>… or /courses/<id>/questions/<id>/submissions');
}

// ---------- Scraping ----------

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function getRawHtml(url) {
  const ctx = await getContext();
  const res = await ctx.request.get(url);
  if (res.url().includes('/login')) throw new Error('Not logged in to Gradescope');
  if (!res.ok()) throw new Error(`GET ${url} -> ${res.status()}`);
  return res.text();
}

// Entities decoded so JSON fields inside data-react-props are regex-able
const getHtml = async (url) => decodeEntities(await getRawHtml(url));

// Gradescope link text is "Name (email@berkeley.edu)"
function splitNameEmail(text) {
  const m = text.trim().match(/^(.*?)\s*\(([^()\s]+@[^()\s]+)\)$/);
  return m ? { name: m[1], email: m[2] } : { name: text.trim(), email: null };
}

async function listSubmissions(courseId, assignmentId) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(`${GS}/courses/${courseId}/assignments/${assignmentId}/review_grades`, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('/login')) throw new Error('Not logged in to Gradescope');
    const subs = await page.$$eval('a[href*="/submissions/"]', (links) =>
      links.map((a) => {
        const m = a.getAttribute('href').match(/\/assignments\/\d+\/submissions\/(\d+)/);
        return m ? { id: m[1], text: a.textContent } : null;
      }).filter(Boolean)
    );
    const seen = new Set();
    return subs.filter((s) => !seen.has(s.id) && seen.add(s.id)).map((s) => ({ id: s.id, ...splitNameEmail(s.text) }));
  } finally {
    await page.close();
  }
}

// The question submissions table links to question-submission ids, which are not the
// assignment-submission ids the .zip download needs. Returns the assignment id plus rows.
async function listQuestionSubmissions(courseId, questionId) {
  const html = await getHtml(`${GS}/courses/${courseId}/questions/${questionId}/submissions`);
  const assignmentId = (html.match(/trn:assignment:[^"]*?::(\d+)/) || html.match(/\/assignments\/(\d+)\//) || [])[1];
  if (!assignmentId) throw new Error('Could not determine the assignment id from the question page');
  const rows = [...html.matchAll(/href="\/courses\/\d+\/questions\/\d+\/submissions\/(\d+)\/grade"[^>]*>([^<]+)<\/a>/g)]
    .map((m) => ({ questionSubmissionId: m[1], ...splitNameEmail(m[2]) }));
  return { assignmentId, rows };
}

// The question grade page embeds a SubmissionGrader React component whose props hold
// assignment_submission.id and a files[] list ({ path, url } with presigned S3 urls).
function parseSubmissionGraderProps(rawHtml) {
  const m = rawHtml.match(/data-react-class="SubmissionGrader"\s+data-react-props="([^"]*)"/);
  if (!m) return { submissionId: null, files: [] };
  const props = JSON.parse(decodeEntities(m[1]));
  const submissionId = props.assignment_submission?.id ? String(props.assignment_submission.id) : null;
  const files = (props.files || [])
    .map((f) => ({ path: f.path, url: f.url || f.file?.url }))
    .filter((f) => f.path && f.url);
  return { submissionId, files };
}

async function loadGradePage(courseId, questionId, qsid) {
  return parseSubmissionGraderProps(await getRawHtml(`${GS}/courses/${courseId}/questions/${questionId}/submissions/${qsid}/grade`));
}

// Rebuild a zip from individually downloaded files so it goes through the same extraction path
async function zipFromFileList(files) {
  const ctx = await getContext();
  const zip = new AdmZip();
  for (const f of files) {
    if (IGNORED.test(f.path)) continue;
    const res = await ctx.request.get(f.url);
    if (!res.ok()) throw new Error(`Download of ${f.path} failed (${res.status()})`);
    zip.addFile(f.path, await res.body());
  }
  return zip.toBuffer();
}

// Gradescope serves the original upload at <submission>.zip; returns null if that doesn't work
async function tryZipEndpoint(courseId, assignmentId, submissionId) {
  const ctx = await getContext();
  const res = await ctx.request.get(`${GS}/courses/${courseId}/assignments/${assignmentId}/submissions/${submissionId}.zip`);
  if (!res.ok()) return null;
  const buf = await res.body();
  return buf[0] === 0x50 && buf[1] === 0x4b ? buf : null; // "PK"
}

// Last resort: open the page and click its download link
async function downloadViaPage(url) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const link = page.locator('a[href$=".zip"], a:has-text("Download")').first();
    await link.waitFor({ timeout: 10000 }).catch(() => {});
    if (!(await link.count())) throw new Error('No download link found on submission page');
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    return fs.readFileSync(await download.path());
  } finally {
    await page.close();
  }
}

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

// ---------- Jobs ----------

const jobs = new Map();

async function runFetch(job, url) {
  const target = parseGradescopeUrl(url);
  const { courseId } = target;
  if (!(await isLoggedIn())) throw new Error('Not logged in. Click "Log in to Gradescope" first.');

  // Normalize both URL kinds into [{ id, name, email, fetchZip }]
  let assignmentId = target.assignmentId;
  let subs;
  job.log('Listing submissions…');
  if (target.questionId) {
    const q = await listQuestionSubmissions(courseId, target.questionId);
    assignmentId = q.assignmentId;
    const rows = target.questionSubmissionId ? q.rows.filter((r) => r.questionSubmissionId === target.questionSubmissionId) : q.rows;
    subs = rows.map((r) => ({
      id: `q${r.questionSubmissionId}`, // replaced with the real submission id once resolved
      name: r.name,
      email: r.email,
      async fetchZip() {
        const g = await loadGradePage(courseId, target.questionId, r.questionSubmissionId);
        if (g.submissionId) this.id = g.submissionId;
        return (g.submissionId && (await tryZipEndpoint(courseId, assignmentId, g.submissionId)))
          || (g.files.length && (await zipFromFileList(g.files)))
          || downloadViaPage(`${GS}/courses/${courseId}/questions/${target.questionId}/submissions/${r.questionSubmissionId}/grade`);
      },
    }));
  } else {
    const list = target.submissionId
      ? [{ id: target.submissionId, name: `Submission ${target.submissionId}`, email: null }]
      : await listSubmissions(courseId, assignmentId);
    subs = list.map((s) => ({
      ...s,
      fetchZip: async () => (await tryZipEndpoint(courseId, assignmentId, s.id))
        || downloadViaPage(`${GS}/courses/${courseId}/assignments/${assignmentId}/submissions/${s.id}`),
    }));
  }

  const assignDir = path.join(DATA_DIR, assignmentId);
  fs.mkdirSync(assignDir, { recursive: true });
  const manifestPath = path.join(assignDir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { courseId, assignmentId, url, submissions: {} };

  // A single-submission URL has no name; keep the one from an earlier full fetch if any
  for (const s of subs) if (manifest.submissions[s.id]?.name && /^Submission \d+$/.test(s.name)) s.name = manifest.submissions[s.id].name;
  job.total = subs.length;
  job.log(`Found ${subs.length} submission(s)`);

  let i = 0;
  async function worker() {
    while (i < subs.length) {
      const s = subs[i++];
      try {
        const buf = await s.fetchZip();
        const dir = path.join(assignDir, s.id);
        fs.rmSync(dir, { recursive: true, force: true });
        extractZip(buf, dir);
        manifest.submissions[s.id] = { id: s.id, name: s.name, email: s.email, fetchedAt: new Date().toISOString() };
        job.log(`✓ ${s.name}`);
      } catch (e) {
        manifest.submissions[s.id] = { id: s.id, name: s.name, error: e.message };
        job.log(`✗ ${s.name}: ${e.message}`);
      }
      job.done++;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
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
  runFetch(job, req.body.url)
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
      return { assignmentId: m.assignmentId, courseId: m.courseId, url: m.url, count: Object.keys(m.submissions).length };
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
