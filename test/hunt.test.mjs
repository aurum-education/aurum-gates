// Tests for `flake-hunt` (step 6.156 slice 2): AC1 (one issue across two runs), AC2 (the body's field list).
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { main } from '../src/cli.mjs';
import { BODY_FIELDS, body, hunt, junitFromZip, title } from '../src/hunt.mjs';

const xml = (cases) =>
  `<testsuites>${cases.map(([c, n, bad]) => `<testcase classname="${c}" name="${n}">${bad ? '<failure message="SECRET page text"/>' : ''}</testcase>`).join('')}</testsuites>`;

/** A zip with deflated entries, as GitHub writes an artifact. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const flaky = [['a.test', 'one', true]];
const fixed = [['a.test', 'one']];

/** A fake GitHub: `runs` rerun-passed runs, each with the given attempt-1 and last reports; `open` issue titles. */
function fake({ runs, open = [], created = [], closedIssues = [] }) {
  const artifacts = {};
  const list = runs.map(([id, first, last, attempt = 2]) => {
    artifacts[id] = [
      { id: id * 10, name: 'test-reports-attempt-1', expired: false },
      { id: id * 10 + 1, name: `test-reports-attempt-${attempt}`, expired: false },
    ];
    return { id, run_attempt: attempt, head_sha: `sha${id}`, files: [first, last] };
  });
  return async (path, { method, body: b, raw } = {}) => {
    if (path.includes('/workflows/')) return { workflow_runs: list };
    if (path.includes('/artifacts?')) return { artifacts: artifacts[Number(path.split('/runs/')[1].split('/')[0])] };
    if (raw) {
      const n = Number(path.split('/artifacts/')[1].split('/')[0]);
      const run = list.find((r) => r.id === Math.floor(n / 10));
      return zip({ 'reports/junit.xml': xml(run.files[n % 10]) });
    }
    if (path.includes('state=closed')) return closedIssues;
    if (method === 'POST') {
      created.push(b);
      return {};
    }
    return open.map((t) => ({ title: t }));
  };
}

describe('junitFromZip', () => {
  it('reads junit files at any depth and ignores other entries', () => {
    const z = zip({ 'reports/junit.xml': xml(fixed), 'coverage/coverage-summary.json': '{}' });
    assert.equal(junitFromZip(z).length, 1);
  });
});

describe('hunt', () => {
  it('files one issue for a test that flaked on two runs (AC1)', async () => {
    const created = [];
    const gh = fake({
      runs: [
        [1, flaky, fixed],
        [2, flaky, fixed],
      ],
      created,
    });
    const stats = await hunt({ gh, repo: 'o/web', since: '2026-11-24' });
    assert.equal(created.length, 1);
    assert.equal(created[0].title, title('a.test > one'));
    assert.deepEqual(created[0].labels, ['flaky']);
    assert.equal(stats.filed.length, 1);
  });

  it('files nothing when an open issue has the title, and on a second night', async () => {
    const created = [];
    const gh = fake({ runs: [[1, flaky, fixed]], open: [title('a.test > one')], created });
    const stats = await hunt({ gh, repo: 'o/web', since: '2026-11-24' });
    assert.equal(created.length, 0);
    assert.equal(stats.existing, 1);
  });

  it('does not file again a flake whose issue was closed in the window for the same run', async () => {
    const created = [];
    const closedIssues = [{ title: title('a.test > one'), body: 'run: https://github.com/o/web/actions/runs/1' }];
    const gh = fake({ runs: [[1, flaky, fixed]], closedIssues, created });
    await hunt({ gh, repo: 'o/web', since: '2026-11-24' });
    assert.equal(created.length, 0);
    const again = fake({ runs: [[2, flaky, fixed]], closedIssues, created });
    await hunt({ gh: again, repo: 'o/web', since: '2026-11-24' });
    assert.equal(created.length, 1);
  });

  it('counts an attempt that failed with no failed test as infra and files nothing', async () => {
    const created = [];
    const gh = fake({ runs: [[1, fixed, fixed]], created });
    const stats = await hunt({ gh, repo: 'o/web', since: '2026-11-24' });
    assert.equal(created.length, 0);
    assert.equal(stats.infra, 1);
  });

  it('a dry run files nothing', async () => {
    const created = [];
    const stats = await hunt({
      gh: fake({ runs: [[1, flaky, fixed]], created }),
      repo: 'o/web',
      since: 'x',
      dryRun: true,
    });
    assert.equal(created.length, 0);
    assert.equal(stats.filed.length, 1);
  });

  it('the issue body carries the field list and no report text (AC2)', () => {
    const text = body({
      repo: 'o/web',
      test: 'a.test > one',
      sha: 'abc',
      run: 'https://x/runs/1',
      message: 'SECRET page text',
    });
    assert.deepEqual(
      text.split('\n').map((l) => l.split(':')[0]),
      BODY_FIELDS,
    );
    assert.ok(!text.includes('SECRET'));
  });
});

describe('flake-hunt command', () => {
  it('needs --repo and a token', async () => {
    const r = await main(['flake-hunt']);
    assert.equal(r.code, 2);
  });

  it('refuses a --days that is not a positive number', async () => {
    process.env.GITHUB_TOKEN = 'x';
    assert.equal((await main(['flake-hunt', '--repo', 'o/web', '--days', 'abc'])).code, 2);
  });

  it('prints one summary line of counts', async () => {
    process.env.GITHUB_TOKEN = 'x';
    const r = await main(['flake-hunt', '--repo', 'o/web', '--dry-run'], {
      hunter: fake({ runs: [[1, flaky, fixed]] }),
    });
    assert.equal(r.code, 0);
    assert.match(r.summary, /1 rerun-passed run\(s\) of 1, 1 flaky test\(s\), 1 new issue\(s\)/);
  });
});
