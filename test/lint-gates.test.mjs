// Tests for the `lint-bans` and `suppressions` gates and the ban-list config (assurance step 1, DS-059 §4.1).
// Each rule has a failing and a passing case; the allowance of a rule is a reason after the directive.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../src/cli.mjs';
import { BAN_RULES, bans } from '../src/eslint.mjs';
import { find as findBans } from '../src/gates/lint-bans.mjs';
import { SUPPRESSION_RULES, find as findSuppressions, scanText } from '../src/gates/suppressions.mjs';

const root = mkdtempSync(join(tmpdir(), 'gates-lint-'));
after(() => rmSync(root, { recursive: true, force: true }));
const put = (file, text) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

describe('suppressions: the text scan', () => {
  it('counts any, in the forms a type is written', () => {
    assert.deepEqual(scanText('const a: any = 1;\nconst b = x as any;\nconst c: Array<any> = [];\nfn<T, any>();'), {
      'explicit-any': 4,
    });
  });
  it('counts = any, => any, keyof any, and any after a // inside a string', () => {
    assert.deepEqual(
      scanText('type T = any;\ntype F = (a: string) => any;\ntype K = keyof any;\nconst u = "http://x"; let a: any;'),
      {
        'explicit-any': 4,
      },
    );
  });
  it('ignores any inside strings and template literals', () => {
    assert.deepEqual(scanText('const s = "Pick one, any one";\nconst t = `Choose: any answer`;'), {});
  });
  it('ignores any inside a multi-line block comment, and counts code after it closes', () => {
    assert.deepEqual(
      scanText('/**\n * Exactly one field: any other is a 400.\n */\nlet a: any;\n/* one\n two: any */ let b: any;'),
      {
        'explicit-any': 2,
      },
    );
  });
  it('does not read prose that mentions a directive as a directive', () => {
    assert.deepEqual(scanText('// we never use eslint-disable or @ts-ignore here'), {});
  });
  it('passes unknown, a word in a comment and a name that contains any', () => {
    assert.deepEqual(
      scanText('const a: unknown = 1; // not any more\nconst company = 1;\nconst many: Anything = 1;'),
      {},
    );
  });
  it('counts a ts directive, and one without a reason', () => {
    assert.deepEqual(scanText('// @ts-ignore\nx();'), { 'ts-suppression': 1, 'ts-suppression-no-reason': 1 });
    assert.deepEqual(scanText('// @ts-expect-error: the lib types this as never until 5.3'), { 'ts-suppression': 1 });
  });
  it('counts an eslint-disable, and one without a reason', () => {
    assert.deepEqual(scanText('x(); // eslint-disable-line no-console'), {
      'eslint-disable': 1,
      'eslint-disable-no-reason': 1,
    });
    assert.deepEqual(scanText('// eslint-disable-next-line no-console -- the CLI prints its result'), {
      'eslint-disable': 1,
    });
    assert.deepEqual(scanText('/* eslint-disable no-console -- short */'), {
      'eslint-disable': 1,
      'eslint-disable-no-reason': 1,
    });
  });
  it('walks source files and leaves tests, declarations and root build output out; src/build is source', () => {
    put('build/x.ts', 'let a: any;\n');
    put('src/build/y.ts', 'let a: any;\n');
    put('test/z.ts', 'let a: any;\n');
    put('fixtures/z.ts', 'let a: any;\n');
    put('src/db-testing.ts', 'let a: any;\n');
    put('src/a.ts', 'let a: any;\n');
    put('src/a.test.ts', 'let a: any;\n');
    put('src/types.d.ts', 'let a: any;\n');
    put('e2e/b.ts', 'let a: any;\n');
    put('dist/c.js', '// @ts-ignore\n');
    put('node_modules/d/index.js', '// @ts-ignore\n');
    assert.deepEqual(findSuppressions({ root }), {
      'src/a.ts': { 'explicit-any': 1 },
      'src/build/y.ts': { 'explicit-any': 1 },
    });
  });
  it('has a rule table entry for every rule it counts', () => {
    for (const rule of [
      'explicit-any',
      'ts-suppression',
      'ts-suppression-no-reason',
      'eslint-disable',
      'eslint-disable-no-reason',
    ])
      assert.ok(SUPPRESSION_RULES[rule].why && SUPPRESSION_RULES[rule].fix);
  });
});

describe('lint-bans: the ESLint report', () => {
  const report = (files) => put('reports/eslint-bans.json', JSON.stringify(files));
  it('counts findings per file and rule, with root-relative paths', () => {
    report([
      {
        filePath: join(root, 'src/a.ts'),
        messages: [{ ruleId: 'no-eval' }, { ruleId: 'no-eval' }, { ruleId: 'no-restricted-properties' }],
      },
      { filePath: join(root, 'src/b.ts'), messages: [] },
    ]);
    assert.deepEqual(findBans({ root }), { 'src/a.ts': { 'no-eval': 2, 'no-restricted-properties': 1 } });
  });
  it('skips a directive notice (no rule id, not fatal) and counts the rest', () => {
    report([{ filePath: join(root, 'src/a.ts'), messages: [{ ruleId: null, severity: 1 }, { ruleId: 'no-eval' }] }]);
    assert.deepEqual(findBans({ root }), { 'src/a.ts': { 'no-eval': 1 } });
  });
  it('throws on a parse error, an unknown rule and a report that is not a list', () => {
    report([{ filePath: join(root, 'a.ts'), messages: [{ ruleId: null, fatal: true }] }]);
    assert.throws(() => findBans({ root }), /a parse error/);
    report([{ filePath: join(root, 'a.ts'), messages: [{ ruleId: 'semi' }] }]);
    assert.throws(() => findBans({ root }), /unknown rule "semi"/);
    put('reports/eslint-bans.json', '{}');
    assert.throws(() => findBans({ root }), /not an ESLint JSON report/);
  });
  it('is a broken gate when the report is missing', () => {
    rmSync(join(root, 'reports'), { recursive: true });
    assert.throws(() => findBans({ root }), /missing or cannot be read/);
  });
});

// Each describe below uses the shared tmp root; the first CLI case removes what the walk test left.
describe('the CLI: init, run, tighten on both gates', () => {
  it('init writes a baseline once and never again; run then passes; a new finding fails; tighten lowers', async () => {
    rmSync(join(root, 'src'), { recursive: true, force: true });
    put('quality/gates.json', JSON.stringify({ suppressions: { mode: 'ratchet' } }));
    put('src/a.ts', 'let a: any;\nlet b: any;\n');
    const written = await main(['init', 'suppressions'], { root });
    assert.equal(written.code, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'quality/baselines/suppressions.json'), 'utf8')), {
      'src/a.ts': { 'explicit-any': 2 },
    });
    put('src/a.ts', 'let a: any;\n');
    await main(['init', 'suppressions'], { root }); // exists: untouched
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'quality/baselines/suppressions.json'), 'utf8')), {
      'src/a.ts': { 'explicit-any': 2 },
    });
    assert.match(
      (await main(['run', 'suppressions'], { root })).text,
      /lower quality\/baselines\/suppressions.json to 1/,
    );
    assert.equal((await main(['tighten', 'suppressions'], { root })).code, 0);
    assert.equal((await main(['run', 'suppressions'], { root })).code, 0);
    put('src/a.ts', 'let a: any;\nlet c: any;\n');
    const rise = await main(['run', 'suppressions'], { root });
    assert.equal(rise.code, 1);
    assert.match(rise.text, /GATE suppressions ✗ src\/a.ts {2}explicit-any/);
    assert.match(rise.text, /Mode: {2}ratchet\. Baseline 1, now 2/);
  });
});

describe('bans(): the ESLint config', () => {
  const rulesOf = (config) => [...new Set(config.flatMap((c) => Object.keys(c.rules ?? {})))];
  it('has only core rules by default, every one a warning and a known rule of the gate', () => {
    const [, main] = bans();
    assert.deepEqual(Object.keys(main.rules).sort(), [
      'no-eval',
      'no-implied-eval',
      'no-new-func',
      'no-restricted-imports',
      'no-restricted-properties',
      'no-restricted-syntax',
    ]);
    for (const [rule, setting] of Object.entries(main.rules)) {
      assert.equal([setting].flat()[0], 'warn');
      assert.ok(Object.hasOwn(BAN_RULES, rule));
    }
  });
  it('adds the any rule with typescript-eslint, the regex rules with the security plugin, the promise rules when type-aware', () => {
    const plugin = {};
    const parser = {};
    assert.ok(rulesOf(bans({ parser, plugin })).includes('@typescript-eslint/no-explicit-any'));
    assert.ok(rulesOf(bans({ security: {} })).includes('security/detect-unsafe-regex'));
    const typed = bans({ parser, plugin, typeAware: true });
    assert.ok(rulesOf(typed).includes('@typescript-eslint/no-floating-promises'));
    assert.deepEqual(typed[2].languageOptions.parserOptions, { projectService: true });
    for (const rule of rulesOf(typed)) assert.ok(Object.hasOwn(BAN_RULES, rule), rule);
  });
  it('refuses type-aware without the parser, and an allowance for an unknown rule', () => {
    assert.throws(() => bans({ typeAware: true }), /needs `parser` and `plugin`/);
    assert.throws(() => bans({ allow: { semi: ['a.ts'] } }), /unknown rule "semi"/);
  });
  it('lints JS only without a parser, ignores inline directives and tests, and catches import() of child_process', () => {
    const [ignore, main] = bans();
    assert.deepEqual(main.files, ['**/*.{js,mjs,cjs}']);
    assert.equal(main.linterOptions.noInlineConfig, true);
    for (const glob of ['**/test/', '**/e2e/', '**/*.test.*', '**/build/']) assert.ok(ignore.ignores.includes(glob));
    assert.match(JSON.stringify(main.rules['no-restricted-syntax']), /ImportExpression/);
  });
  it('turns a rule off for an allowlisted path', () => {
    const config = bans({ allow: { 'no-restricted-imports': ['scripts/**'] } });
    assert.deepEqual(config.at(-1), { files: ['scripts/**'], rules: { 'no-restricted-imports': 'off' } });
  });
});
