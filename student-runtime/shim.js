// Preloaded (node -r) into every student process. Student code hardcodes app.listen(3000), so
// listen() is patched to bind an OS-assigned port on 127.0.0.1 instead, whatever port or host
// was asked for. The real port is reported to the grader over the IPC channel.
'use strict';
const net = require('net');

const origListen = net.Server.prototype.listen;
let reported = false;

net.Server.prototype.listen = function patchedListen(...args) {
  const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
  // Only the first server is reachable from the grader; any others still bind loopback only
  this.once('listening', () => {
    if (reported) return;
    reported = true;
    if (process.send) process.send({ type: 'listening', port: this.address().port });
  });
  return origListen.call(this, { port: 0, host: '127.0.0.1' }, cb);
};

if (process.send) process.send({ type: 'started' });
