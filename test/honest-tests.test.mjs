// Tests for the `honest-tests` gate (G1, step 6.152): each rule has a failing and a passing case, and the allowance.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../src/cli.mjs';
import { HONEST_RULES, scanText } from '../src/gates/honest-tests.mjs';

const hits = (text, file = 'src/a.test.ts') => scanText(file, text);
const root = mkdtempSync(join(tmpdir(), 'gates-honest-'));
after(() => rmSync(root, { recursive: true, force: true }));
const put = (file, text) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

describe('honest-tests: the canonical rules', () => {
  it('flags waitForTimeout, except in e2e/perf', () => {
    assert.deepEqual(hits('await page.waitForTimeout(50);'), { 'wait-for-timeout': 1 });
    assert.deepEqual(hits('await page.waitForTimeout(50);', 'e2e/perf/a.spec.ts'), {});
  });
  it('flags a real-time wait, not the settle helper, not e2e/perf; test.setTimeout is a timeout', () => {
    assert.deepEqual(hits('await new Promise((r) => setTimeout(r, 5));'), { 'real-time-wait': 1 });
    assert.deepEqual(hits("import { setTimeout } from 'node:timers/promises';"), { 'real-time-wait': 1 });
    assert.deepEqual(hits('test.setTimeout(9);'), { 'raised-timeout': 1 });
    assert.deepEqual(hits('setTimeout(r, 5);', 'test/settle.ts'), {});
    assert.deepEqual(hits('setTimeout(r, 5);', 'e2e/perf/a.spec.ts'), {});
  });
  it('flags force: true, not the force flag of rm', () => {
    assert.deepEqual(hits('await b.click({ force: true });'), { 'forced-interaction': 1 });
    assert.deepEqual(hits('rmSync(dir, { recursive: true, force: true });'), {});
  });
  it('flags an outcome set, and allows it with a spec comment above', () => {
    assert.deepEqual(hits('expect([200, 204]).toContain(res.status);'), { 'outcome-set': 1 });
    assert.deepEqual(hits('// spec: DS-013 §4.2\nexpect([200, 204]).toContain(res.status);'), {});
    assert.deepEqual(hits('// see DS-013 §4.2\nexpect([200, 204]).toContain(res.status);'), { 'outcome-set': 1 });
  });
  it('flags an open-ended status, and allows it with a spec comment above', () => {
    assert.deepEqual(hits('expect(res.status).toBeGreaterThanOrEqual(500);'), { 'open-status': 1 });
    assert.deepEqual(hits('// spec: REQ-API-001 §2\nexpect(res.status).toBeGreaterThanOrEqual(500);'), {});
    assert.deepEqual(hits('expect(res.status).toBe(500);'), {});
  });
  it('does not scan a file that is not a test', () => {
    assert.deepEqual(hits('setTimeout(r, 5);', 'src/a.ts'), {});
  });
});

describe('honest-tests: the new rules', () => {
  it('flags a bare tick', () => {
    assert.deepEqual(hits('await act(async () => {});'), { 'bare-tick': 1 });
    assert.deepEqual(hits('act(() => undefined);'), { 'bare-tick': 1 });
    assert.deepEqual(hits('vi.advanceTimersByTime(0);'), { 'bare-tick': 1 });
    assert.deepEqual(hits('vi.runOnlyPendingTimers();\nvi.runOnlyPendingTimers();'), { 'bare-tick': 1 });
    assert.deepEqual(hits('vi.runOnlyPendingTimers();\nexpect(a).toBe(1);\nvi.runOnlyPendingTimers();'), {});
    assert.deepEqual(hits('await act(async () => { await go(); });\nvi.advanceTimersByTime(10);'), {});
  });
  it('flags a microtask or frame wait', () => {
    for (const code of [
      'await new Promise((r) => setImmediate(r));',
      'queueMicrotask(f);',
      'process.nextTick(f);',
      'requestAnimationFrame(f);',
    ])
      assert.deepEqual(hits(code), { 'microtask-or-frame-wait': 1 }, code);
    assert.deepEqual(hits('await findByText("x");'), {});
  });
  it('flags a test-level timeout', () => {
    assert.deepEqual(hits("it('a', async () => {\n  x();\n}, 30_000);"), { 'raised-timeout': 1 });
    assert.deepEqual(hits("test('a', { timeout: 60000 }, async () => {});"), { 'raised-timeout': 1 });
    assert.deepEqual(hits('vi.setConfig({ testTimeout: 9000 });'), { 'raised-timeout': 1 });
    assert.deepEqual(hits("it('a', async () => {\n  x();\n});"), {});
  });
  it('flags a config timeout and retries', () => {
    const c = (text) => hits(text, 'vitest.config.ts');
    assert.deepEqual(c('export default { test: { testTimeout: 20000 } };'), { 'raised-timeout': 1 });
    assert.deepEqual(c('export default { test: { retry: 2 } };'), { 'retry-config': 1 });
    assert.deepEqual(c('export default { test: { retry: 0 } };'), {});
    const p = (text) => hits(text, 'apps/web/playwright.config.ts');
    assert.deepEqual(p('export default { retries: 2, failOnFlakyTests: true };'), { 'retry-config': 1 });
    assert.deepEqual(p('export default { retries: 1 };'), { 'retry-config': 1 });
    assert.deepEqual(p('export default { retries: process.env.CI ? 1 : 0, failOnFlakyTests: true };'), {});
    assert.deepEqual(p('export default { retries: 0 };'), {});
  });
});

describe('honest-tests: the command', () => {
  it('fails in enforce on a canonical rule, never on a report-only rule', async () => {
    put('quality/gates.json', JSON.stringify({ 'honest-tests': { mode: 'enforce' } }));
    put('a.test.ts', 'requestAnimationFrame(f);\n');
    assert.equal((await main(['run', 'honest-tests'], { root })).code, 0);
    put('b.test.ts', 'await page.waitForTimeout(5);\n');
    const result = await main(['run', 'honest-tests'], { root });
    assert.equal(result.code, 1);
    assert.match(result.text, /GATE honest-tests ✗ b\.test\.ts {2}wait-for-timeout/);
  });
  it('is a broken gate, not a pass, when no test file exists', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gates-honest-empty-'));
    mkdirSync(join(empty, 'quality'));
    writeFileSync(join(empty, 'quality/gates.json'), JSON.stringify({ 'honest-tests': { mode: 'report' } }));
    assert.equal((await main(['run', 'honest-tests'], { root: empty })).code, 2);
    rmSync(empty, { recursive: true, force: true });
  });
  it('has a why and a fix for every rule', () => {
    for (const r of Object.values(HONEST_RULES)) assert.ok(r.why && r.fix);
  });
});
