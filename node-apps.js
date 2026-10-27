// Runs student Node.js servers (HW6: an Express flashcard API) so the grader can send them
// requests Postman-style. Each submission's entry file runs as a child process on an
// OS-assigned loopback port; server.js proxies requests to it.
//
// Student code is untrusted, so every process runs under Node's permission model: it may read
// its own folder and student-runtime/ (where express, body-parser and cors are installed, since
// students submit index.js alone) and nothing else. No writes, no child processes, no workers,
// and none of the grader's environment (.env) reaches it. The model can't block outbound
// network, which is the residual risk of running submissions natively.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const RUNTIME_DIR = path.join(__dirname, 'student-runtime');
const RUNTIME_MODULES = path.join(RUNTIME_DIR, 'node_modules');
const SHIM = path.join(RUNTIME_DIR, 'shim.js');

const MAX_APPS = 3;                 // running student processes; the least recently used is killed
const APP_START_MS = 10000;         // a process that hasn't called listen() by then is reported
const APP_IDLE_MS = 10 * 60 * 1000; // kill apps nobody has sent a request to for this long
const APP_REQUEST_MS = 8000;        // proxied request timeout
const MAX_APP_LOG = 300;            // lines of stdout/stderr kept per app
const MAX_RESPONSE = 1024 * 1024;   // bytes of a proxied response body passed on to the grader

const [NODE_MAJOR, NODE_MINOR] = process.versions.node.split('.').map(Number);
// --permission since 22.13, --experimental-permission on 20.0-22.12; older Node can't sandbox
const PERMISSION_FLAG = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 13) ? '--permission'
  : NODE_MAJOR >= 20 ? '--experimental-permission' : null;

// ---------- Entry file ----------

const ENTRY_NAMES = ['index.js', 'server.js', 'app.js', 'main.js'];
const SERVER_CODE = /require\(\s*['"](express|http)['"]\s*\)|from\s+['"](express|http)['"]|\.listen\(/;

// The .js file that starts a server (requires express/http or calls listen), preferring
// index.js, then the other conventional names, then the shallowest. null for static submissions.
function findEntryJs(files, dir) {
  const rank = (p) => {
    const i = ENTRY_NAMES.indexOf(p.split('/').pop().toLowerCase());
    return (i < 0 ? ENTRY_NAMES.length : i) * 100 + p.split('/').length;
  };
  const js = files.filter((f) => /\.(js|cjs)$/i.test(f.path) && f.size < 512 * 1024).sort((a, b) => rank(a.path) - rank(b.path));
  for (const f of js) {
    try { if (SERVER_CODE.test(fs.readFileSync(path.join(dir, f.path), 'utf8'))) return f.path; } catch { /* unreadable */ }
  }
  return null;
}

// ---------- Processes ----------

// key -> record, least recently used first. Status: starting | running | no-server (alive but
// never called listen) | exited (exitCode/signal) | failed (couldn't launch)
const apps = new Map();

function startApp(key, dir, entry) {
  const rec = { key, entry, status: 'starting', port: null, pid: null, exitCode: null, signal: null, error: null, logs: [], requests: 0, startedAt: Date.now(), lastUsed: Date.now(), child: null, killed: false, ready: Promise.resolve() };
  const log = (stream, text) => {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line) continue;
      rec.logs.push({ stream, line });
      if (rec.logs.length > MAX_APP_LOG) rec.logs.shift();
    }
  };
  const fail = (msg) => { rec.status = 'failed'; rec.error = msg; return rec; };
  if (!PERMISSION_FLAG) return fail(`Running student servers needs Node.js 20 or newer (this is ${process.versions.node})`);
  if (!fs.existsSync(RUNTIME_MODULES)) return fail('student-runtime/node_modules is missing: run "npm install" in the grader folder');

  const args = [PERMISSION_FLAG, `--allow-fs-read=${dir}`, `--allow-fs-read=${RUNTIME_DIR}`, '--no-warnings', '--require', SHIM, path.join(dir, entry)];
  // A bare environment: nothing from the grader's .env (MONGODB_URI) reaches student code
  const env = { NODE_PATH: RUNTIME_MODULES };
  for (const k of ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG']) if (process.env[k]) env[k] = process.env[k];
  let child;
  try { child = spawn(process.execPath, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); }
  catch (e) { return fail(e.message); }
  rec.child = child;
  rec.pid = child.pid;
  child.stdout.on('data', (d) => log('out', d));
  child.stderr.on('data', (d) => log('err', d));
  rec.ready = new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); resolve(rec); };
    const timer = setTimeout(() => {
      if (rec.status === 'starting') { rec.status = 'no-server'; rec.error = `No server started within ${APP_START_MS / 1000}s. Does the file call app.listen()?`; }
      finish();
    }, APP_START_MS);
    child.on('message', (m) => {
      if (m?.type === 'listening' && rec.status === 'starting') { rec.status = 'running'; rec.port = m.port; finish(); }
    });
    child.on('error', (e) => { rec.status = 'failed'; rec.error = e.message; finish(); });
    child.on('exit', (code, signal) => {
      rec.status = 'exited';
      rec.exitCode = code;
      rec.signal = signal;
      rec.port = null;
      if (!rec.killed) rec.error = code ? `Exited with code ${code}` : signal ? `Killed by ${signal}` : rec.port ? 'Exited' : 'Exited without starting a server. Does the file call app.listen()?';
      finish();
    });
  });
  return rec;
}

// Kills the process; resolves once it has exited (or after 2s)
function stopApp(rec) {
  rec.killed = true;
  const child = rec.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 2000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill();
  });
}

function evict(key) {
  const rec = apps.get(key);
  apps.delete(key);
  return rec ? stopApp(rec) : Promise.resolve();
}

// The app for a submission, launched if it isn't running yet. Marked most recently used.
// An app we killed ourselves (eviction, idle) restarts; one that crashed stays "exited" with
// its logs, which is grading information, until the grader asks for a restart.
function getApp(key, dir, entry, restart = false) {
  let rec = apps.get(key);
  if (rec && (restart || rec.entry !== entry || (rec.status === 'exited' && rec.killed))) { evict(key); rec = null; }
  if (rec) apps.delete(key); // re-inserted below as most recently used
  else rec = startApp(key, dir, entry);
  rec.lastUsed = Date.now();
  apps.set(key, rec);
  while (apps.size > MAX_APPS) evict(apps.keys().next().value);
  return rec;
}

// Stops every app whose key starts with prefix (an assignment id + "/") and waits for them,
// e.g. before an import deletes their folders (a process's cwd can't be removed on Windows)
function stopApps(prefix = '') {
  return Promise.all([...apps.keys()].filter((k) => k.startsWith(prefix)).map(evict));
}

const appInfo = (rec) => ({ status: rec.status, port: rec.port, entry: rec.entry, error: rec.error, exitCode: rec.exitCode, signal: rec.signal, logs: rec.logs, requests: rec.requests, startedAt: rec.startedAt });

setInterval(() => {
  const cutoff = Date.now() - APP_IDLE_MS;
  for (const [k, rec] of apps) if (rec.lastUsed < cutoff) evict(k);
}, 60000).unref();

process.on('exit', () => { for (const rec of apps.values()) { rec.killed = true; rec.child?.kill(); } });

// ---------- Requests ----------

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// Sends one request to the app. Resolves (never rejects) with
//   { ok: true, status, headers, body, truncated, ms } or { ok: false, error, ms }
function appRequest(rec, { method = 'GET', path: reqPath = '/', headers = {}, body }) {
  rec.requests++;
  rec.lastUsed = Date.now();
  const start = Date.now();
  const ms = () => Date.now() - start;
  if (rec.status !== 'running') return Promise.resolve({ ok: false, error: rec.error || `App is ${rec.status}`, ms: 0 });
  return new Promise((resolve) => {
    const hdrs = { ...headers };
    if (body != null && !Object.keys(hdrs).some((h) => h.toLowerCase() === 'content-type')) hdrs['Content-Type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: rec.port, method, path: reqPath, headers: hdrs, timeout: APP_REQUEST_MS }, (res) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      res.on('data', (c) => {
        if (size + c.length > MAX_RESPONSE) { truncated = true; res.destroy(); return; }
        chunks.push(c);
        size += c.length;
      });
      res.on('error', () => {});
      res.on('close', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), truncated, ms: ms() }));
    });
    req.on('timeout', () => req.destroy(new Error(`No response within ${APP_REQUEST_MS / 1000}s`)));
    req.on('error', (e) => resolve({ ok: false, error: e.message, ms: ms() }));
    if (body != null) req.write(body);
    req.end();
  });
}

// Checks a request from the grader UI; returns an error message or null
function validateRequest({ method, path: p, headers, body }) {
  if (!METHODS.has(method)) return `"method" must be one of ${[...METHODS].join(', ')}`;
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 2000) return '"path" must start with /';
  if (headers != null && (typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some((v) => typeof v !== 'string'))) return '"headers" must map names to strings';
  if (body != null && typeof body !== 'string') return '"body" must be a string';
  if (body && body.length > MAX_RESPONSE) return 'Body is too large';
  return null;
}

// ---------- Tests ----------

// Postman-style checks, run in order against a fresh app. check(result) returns a failure
// reason, or nothing when the step passes. A step with "tries" sends each candidate request
// until one isn't an error, for endpoints whose path the student chooses.
const CARDS = [
  { front: 'What is the capital of France?', back: 'Paris' },
  { front: 'What is 2 + 2?', back: '4' },
  { front: 'Which HTTP status means Not Found?', back: '404' },
];
const parse = (r) => { try { return JSON.parse(r.body); } catch { return undefined; } };
const isCard = (c) => !!c && typeof c === 'object' && 'front' in c && 'back' in c;
const errorStatus = (r) => (r.status >= 400 ? `responded ${r.status}` : undefined);
const cardList = (n, r) => {
  const d = parse(r);
  if (!Array.isArray(d)) return 'response is not a JSON array';
  if (d.length !== n) return `expected ${n} cards, got ${d.length}`;
  if (!d.every(isCard)) return 'some cards are missing front/back';
  return undefined;
};

const API_TESTS = {
  name: 'Flashcard API (HW6)',
  steps: [
    ...CARDS.map((c, i) => ({ name: `Add card ${i + 1}`, method: 'POST', path: '/new', body: c, check: errorStatus })),
    { name: 'List all cards', method: 'GET', path: '/cards', check: (r) => errorStatus(r) || cardList(3, r) },
    {
      name: 'Get card at index 2',
      method: 'GET',
      path: '/card/2',
      check: (r) => {
        if (errorStatus(r)) return errorStatus(r);
        const d = parse(r);
        if (!isCard(d)) return 'response is not a card object';
        if (d.front !== CARDS[2].front) return `expected the third card, got "${d.front}"`;
        return undefined;
      },
    },
    { name: 'Get a random card', method: 'GET', path: '/random', check: (r) => errorStatus(r) || (isCard(parse(r)) ? undefined : 'response is not a card object') },
    {
      name: 'Delete card at index 1',
      tries: ['DELETE /card/1', 'DELETE /cards/1', 'DELETE /delete/1', 'DELETE /remove/1', 'POST /delete/1', 'GET /delete/1'],
      check: errorStatus,
    },
    { name: 'List cards after delete', method: 'GET', path: '/cards', check: (r) => errorStatus(r) || cardList(2, r) || (parse(r).some((c) => c.front === CARDS[1].front) ? 'the deleted card is still there' : undefined) },
  ],
};

async function runTests(rec) {
  const results = [];
  for (const step of API_TESTS.steps) {
    const attempts = step.tries ? step.tries.map((t) => t.split(' ')).map(([method, p]) => ({ method, path: p })) : [{ method: step.method, path: step.path }];
    const body = step.body != null ? JSON.stringify(step.body) : undefined;
    let result;
    for (const a of attempts) {
      const r = await appRequest(rec, { ...a, body });
      result = { name: step.name, method: a.method, path: a.path, body, ...r };
      if (r.ok && r.status < 400) break;
    }
    const reason = result.ok ? step.check(result) : result.error;
    if (reason && step.tries && result.status >= 400) result.tried = step.tries;
    results.push({ ...result, pass: !reason, reason: reason || null });
  }
  return results;
}

module.exports = { findEntryJs, getApp, stopApps, appInfo, appRequest, validateRequest, runTests, API_TESTS };
