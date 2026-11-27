// The shared ban-list ESLint config (DS-059 §4.1, assurance step 1). A repo's own `eslint.bans.config.mjs` returns
// `bans({ ... })`, run as its own pass: `eslint -c eslint.bans.config.mjs -f json -o reports/eslint-bans.json .`
// Every rule is `warn`: the `lint-bans` gate counts findings per file and rule against a shrink-only baseline, so
// existing findings are recorded and a new one fails. Core rules only, so this package keeps zero dependencies; the
// parser and plugins come from the consuming repo (README § Strict lint).
export const BAN_RULES = {
  'no-eval': {
    why: 'eval runs text as code, so any input that reaches it is remote code execution. REQ-SEC.',
    fix: 'parse the data (JSON.parse) or call a function.',
  },
  'no-new-func': { why: 'the Function constructor is eval by another name. REQ-SEC.', fix: 'write the function out.' },
  'no-implied-eval': {
    why: 'setTimeout and setInterval with a string run it as eval. REQ-SEC.',
    fix: 'pass a function.',
  },
  'no-restricted-properties': {
    why: 'Math.random is predictable, so it must not make a token, ID, nonce or key. REQ-SEC.',
    fix: 'use crypto.randomUUID or crypto.getRandomValues, or inject the source (pure code takes it as a parameter).',
    allow: 'a path listed in `allow` in eslint.bans.config.mjs, with the reason beside it.',
  },
  'no-restricted-imports': {
    why: 'child_process starts a process: one unchecked argument is command injection. REQ-SEC.',
    fix: 'do it in code (fs, fetch), or move it to a script on the allowlist.',
    allow: 'a path listed in `allow` in eslint.bans.config.mjs, with the reason beside it.',
  },
  'no-restricted-syntax': {
    why: 'require or import() of child_process starts a process: one unchecked argument is command injection. REQ-SEC.',
    fix: 'do it in code (fs, fetch), or move it to a script on the allowlist.',
    allow: 'a path listed in `allow` in eslint.bans.config.mjs, with the reason beside it.',
  },
  'security/detect-unsafe-regex': {
    why: 'a regex with nested quantifiers can run for minutes on a crafted input (ReDoS). REQ-SEC.',
    fix: 'remove the nested quantifier or bound the input length before matching.',
  },
  'security/detect-non-literal-regexp': {
    why: 'a regex built from a variable lets its input choose the pattern (ReDoS, injection). REQ-SEC.',
    fix: 'use a literal, or escape the input before building the pattern.',
  },
  '@typescript-eslint/no-explicit-any': {
    why: 'any turns the type checker off for everything it touches. DS-013.',
    fix: 'use unknown and narrow it, or write the type.',
  },
  '@typescript-eslint/no-floating-promises': {
    why: 'a promise nobody awaits fails silently: a write that never lands is lost student work. Non-negotiable 3.',
    fix: 'await it, return it, or `void` it with a catch.',
  },
  '@typescript-eslint/no-misused-promises': {
    why: 'a promise in a condition or a void callback is never awaited, so its failure is lost. Non-negotiable 3.',
    fix: 'await it first, or wrap the callback.',
  },
  '@typescript-eslint/no-unsafe-assignment': {
    why: 'an any value flows on unchecked. DS-013.',
    fix: 'type the source, or narrow from unknown.',
  },
  '@typescript-eslint/no-unsafe-call': {
    why: 'calling an any value is unchecked. DS-013.',
    fix: 'type the source, or narrow from unknown.',
  },
  '@typescript-eslint/no-unsafe-member-access': {
    why: 'reading a member of an any value is unchecked. DS-013.',
    fix: 'type the source, or narrow from unknown.',
  },
  '@typescript-eslint/no-unsafe-argument': {
    why: 'passing an any value skips the parameter type. DS-013.',
    fix: 'type the source, or narrow from unknown.',
  },
  '@typescript-eslint/no-unsafe-return': {
    why: 'returning an any value leaks it to every caller. DS-013.',
    fix: 'type the source, or narrow from unknown.',
  },
};

const WARN = 'warn';
const TS_FILES = ['**/*.{ts,tsx,mts,cts}'];
const JS_FILES = ['**/*.{js,mjs,cjs}'];
// The same tests and build output the `suppressions` scan leaves out (src/gates/suppressions.mjs).
const IGNORED = [
  '**/node_modules/',
  '**/dist/',
  '**/coverage/',
  '**/reports/',
  '**/build/',
  '**/.next/',
  '**/out/',
  '**/*.d.ts',
  '**/*.test.*',
  '**/*.spec.*',
  '**/e2e/',
  '**/test/',
  '**/tests/',
  '**/__tests__/',
  '**/fixtures/',
  '**/testing.*',
  '**/*-testing.*',
];
const TYPE_AWARE = [
  'no-floating-promises',
  'no-misused-promises',
  'no-unsafe-assignment',
  'no-unsafe-call',
  'no-unsafe-member-access',
  'no-unsafe-argument',
  'no-unsafe-return',
];
const CHILD_PROCESS = { name: 'child_process', message: 'child_process starts a process (command injection).' };
const CHILD_PROCESS_NODE = { ...CHILD_PROCESS, name: 'node:child_process' };

/**
 * Flat config: `{ parser, plugin, security, typeAware, files, ignores, allow }`.
 *   parser / plugin: typescript-eslint's `tseslint.parser` and `tseslint.plugin` (TypeScript files and the any rule).
 *   security: `eslint-plugin-security`'s default export, when the repo has it (adds the two regex rules).
 *   typeAware: true adds the type-aware rules (needs `parser`; slower, so enable per repo).
 *   allow: { '<rule id>': ['glob', ...] } turns that rule off for those paths (an allowlist; the reason goes in a comment).
 *   ignores: globs left out (default: tests, build output).
 */
export function bans({ parser, plugin, security, typeAware = false, files, ignores = [], allow = {} } = {}) {
  files ??= parser ? [...JS_FILES, ...TS_FILES] : JS_FILES; // TypeScript files need the repo's parser
  if (typeAware && !(parser && plugin))
    throw new Error('bans: typeAware needs `parser` and `plugin` from typescript-eslint');
  const rules = {
    'no-eval': WARN,
    'no-new-func': WARN,
    'no-implied-eval': WARN,
    'no-restricted-properties': [
      WARN,
      {
        object: 'Math',
        property: 'random',
        message: 'Math.random is predictable: use crypto for tokens, IDs and keys.',
      },
    ],
    'no-restricted-imports': [WARN, { paths: [CHILD_PROCESS, CHILD_PROCESS_NODE] }],
    'no-restricted-syntax': [
      WARN,
      {
        selector:
          "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?child_process$/], ImportExpression[source.value=/^(node:)?child_process$/]",
        message: 'child_process starts a process (command injection).',
      },
    ],
  };
  if (security) {
    rules['security/detect-unsafe-regex'] = WARN;
    rules['security/detect-non-literal-regexp'] = WARN;
  }
  const tsRules = {};
  if (plugin) tsRules['@typescript-eslint/no-explicit-any'] = WARN;
  if (typeAware) for (const r of TYPE_AWARE) tsRules[`@typescript-eslint/${r}`] = WARN;
  // Core rules read `setTimeout` as a global: without it no-implied-eval sees nothing.
  const globals = { setTimeout: 'readonly', setInterval: 'readonly', execScript: 'readonly' };
  const off = Object.entries(allow).map(([rule, globs]) => {
    if (!Object.hasOwn(BAN_RULES, rule)) throw new Error(`bans: allow names an unknown rule "${rule}"`);
    return { files: globs, rules: { [rule]: 'off' } };
  });
  return [
    { ignores: [...IGNORED, ...ignores] },
    {
      files,
      plugins: security ? { security } : {},
      languageOptions: { globals },
      linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
      rules,
    },
    // TypeScript files only: the parser, the any rule and the type-aware rules (JS files keep the default parser).
    ...(parser
      ? [
          {
            files: TS_FILES,
            plugins: plugin ? { '@typescript-eslint': plugin } : {},
            languageOptions: { parser, ...(typeAware && { parserOptions: { projectService: true } }) },
            rules: tsRules,
          },
        ]
      : []),
    ...off,
  ];
}
