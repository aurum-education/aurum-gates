import { execSync } from 'node:child_process';
// Cases for aurum.yml: `ruleid` lines must be found, `ok` lines must not (`semgrep --test sast/rules`).
declare const x: string, schema: any, res: any, el: any, cp: any, jwt: any, log: any, req: any, w: any, crypto: any;

// ruleid: aurum.no-eval
eval(x);
// ok: aurum.no-eval
JSON.parse(x);

// ruleid: aurum.no-new-function
new Function('a', x);
// ok: aurum.no-new-function
const f = (a: number) => a;

// ruleid: aurum.no-implied-eval
setTimeout('go()', 10);
// ok: aurum.no-implied-eval
setTimeout(() => f(1), 10);

// ruleid: aurum.child-process-shell
cp.exec(`ls ${x}`);
// ruleid: aurum.child-process-shell
execSync(x);
// ok: aurum.child-process-shell
/^a/.exec(x);
// ok: aurum.child-process-shell
cp.exec('ls -l');
// ok: aurum.child-process-shell
cp.execFile('ls', [x]);

// ruleid: aurum.child-process-spawn-shell
cp.spawn('ls', [x], { shell: true });
// ok: aurum.child-process-spawn-shell
cp.spawn('ls', [x], { shell: false });

// ruleid: aurum.tls-verification-off
const agent = { rejectUnauthorized: false };
// ok: aurum.tls-verification-off
const safe = { rejectUnauthorized: true };

// ruleid: aurum.dom-html-sink
el.innerHTML = x;
// ok: aurum.dom-html-sink
el.innerHTML = '<b>fixed</b>';
// ok: aurum.dom-html-sink
el.textContent = x;

// ruleid: aurum.react-dangerous-html
const bad = <div dangerouslySetInnerHTML={{ __html: x }} />;
// ok: aurum.react-dangerous-html
const good = <div>{x}</div>;

// ruleid: aurum.jwt-none-or-unverified
jwt.sign({}, 'k', { algorithm: 'none' });
// ruleid: aurum.jwt-none-or-unverified
jwt.decode(x);
// ok: aurum.jwt-none-or-unverified
jwt.verify(x, 'k', { algorithms: ['RS256'] });

// ruleid: aurum.log-request-body
console.log('got', req.body);
// ruleid: aurum.log-request-body
log.info(req.body);
// ruleid: aurum.log-request-body
this.logger.warn('bad', res.body);
// ok: aurum.log-request-body
log.info('got', req.id);
// ok: aurum.log-request-body
const parsed = schema.parse(req.body);
// ok: aurum.log-request-body
res.send(req.body);
// ok: aurum.log-request-body
logger.info('size', req.body.length);

// ruleid: aurum.math-random
const r = Math.random();
// ok: aurum.math-random
const u = crypto.randomUUID();

// ruleid: aurum.weak-hash
crypto.createHash('md5');
// ok: aurum.weak-hash
crypto.createHash('sha256');

// ruleid: aurum.non-literal-regexp
new RegExp(x);
// ok: aurum.non-literal-regexp
new RegExp('^a+$', 'u');

// ruleid: aurum.post-message-wildcard
w.postMessage({}, '*');
// ok: aurum.post-message-wildcard
w.postMessage({}, 'https://aurumeducation.com');

// A reasoned allowance: nosemgrep on the line above silences the finding.
// nosemgrep: aurum.math-random -- jitter for a retry delay, not a secret
const jitter = Math.random();
