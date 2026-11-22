// The baseline guard (DS-059 §4.1, step 6.151): a baseline, a ceiling list or an exemption list never grows, and a
// gate's mode never moves backwards, without a `baseline-raise: <label> — <reason>` line in the PR body, which the
// reviewer reads. It compares the watched files with the merge base, so a number the author copied into the baseline in
// the same PR cannot pass by equalling itself. (Moved here from aurum-web's scripts/quality, step 6.160.)
//   aurum-gates baseline-guard [--base <ref>] [--report=<label>] [--config <module>]
//   --base     the commit to compare with (CI gives the merge commit's first parent); default: the merge base with origin/main
//   --report   print that label's findings without failing
//   --config   a module (a path, relative to the repo root) whose named export `config` replaces `DEFAULT_CONFIG` (see below)
// The PR body is read live (PR_NUMBER, GITHUB_TOKEN, GITHUB_REPOSITORY), so adding the line and re-running the job is
// enough; PR_BODY overrides it for a local run.
//
// A repo with more watched files than DS-059's own (aurum-web has UX ones) passes a `config`, see `DEFAULT_CONFIG`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GATES_FILE, MODES, runGate } from './gate.mjs';

/**
 * What the guard watches. `roots` are the paths read from the working tree and the base commit (a file or a folder).
 * `watched` lists what each file is: `match` (a regexp on the path), `label` (match → the gate name the allowance line
 * must give), and optionally `keys` (limits the comparison to the leaves it matches), `newFile: 'allowed'` (a file may
 * appear with no line; any other file may appear only in a PR that adds a gate to quality/gates.json),
 * `removal: true` (a deleted file is a finding), `renames: true` (a moved source file carries its count: the first key
 * of the file is a path), `keyLabel(key, { path, was, now, label })` (a label per key) and
 * `extra({ path, was, now, changed })` (more findings, each with its own `label`). `rules` adds failure messages.
 * `soft(finding, { base, head })` says a finding is reported, not failed. `check`'s `RULES` are the guard's own.
 */
export const DEFAULT_CONFIG = {
  roots: [GATES_FILE, 'quality/baselines'],
  watched: [{ match: /^quality\/baselines\/([^/]+)\.json$/, label: (m) => m[1], renames: true }],
  rules: {},
  soft: () => false,
};

const allowLine = (label) => `\`baseline-raise: ${label} — <reason>\` in the PR body; the reviewer reads it.`;

export const RULES = {
  raised: {
    why: 'a baseline or ceiling only shrinks; a higher number hides a new finding. DS-059 §4.1, workspace rule 10.',
    fix: 'fix the finding so the number stays where the merge base has it.',
  },
  'key-added': {
    why: 'a new entry in a baseline, ceiling or exemption list is a new finding let through. DS-059 §4.1.',
    fix: 'fix the finding instead of listing it.',
  },
  'new-file': {
    why: 'a baseline file may first appear only in the PR that adds its gate to quality/gates.json. DS-059 §4.1.',
    fix: 'add the gate to quality/gates.json in this PR, or remove the file.',
  },
  removed: {
    why: 'a removed file or entry takes its findings out of the ratchet. DS-059 §4.1.',
    fix: 'keep it, or name the cause in the allowance line.',
  },
  'config-changed': {
    why: 'the --config module decides what the guard watches and what it only reports, so a PR that edits it could silence the guard. DS-059 §4.1.',
    fix: 'leave the config as the merge base has it, or change it in a PR of its own.',
  },
  'mode-backwards': {
    why: 'a gate moves report → ratchet → enforce and never back. DS-059 §4.1.',
    fix: 'keep the mode and fix what the gate found.',
  },
};

/**
 * Every leaf of a watched file, keyed by its path joined with ' > ' (IDs in these files contain dots). A watched file
 * is objects keyed by ID all the way down: a list is keyed by position, so swapping one entry for another would look
 * like no change. A list is therefore a broken gate, never a pass.
 */
export function leaves(file, value, path = [], out = new Map()) {
  if (Array.isArray(value)) throw new Error(`${file} holds a list; a watched file must be objects keyed by ID`);
  if (value !== null && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) leaves(file, v, [...path, k], out);
  else out.set(path.join(' > '), value);
  return out;
}

const isNumber = (v) => typeof v === 'number';

function parse(files, file) {
  if (!files.has(file)) return undefined;
  try {
    return JSON.parse(files.get(file));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

/** The base's leaves with each moved source file's key renamed (DS-059 §4.1: a rename with an equal count is neutral). */
function carryRenames(was, renames) {
  const out = new Map();
  for (const [key, value] of was) {
    const [path, ...rest] = key.split(' > ');
    const moved = [renames.get(path) ?? path, ...rest].join(' > ');
    out.set(moved, isNumber(value) && isNumber(out.get(moved)) ? out.get(moved) + value : value);
  }
  return out;
}

/**
 * The guard's findings. `base` and `head` are Maps of path → file text (the merge base and the PR); `changed` is the
 * list of changed paths and `renames` a Map of old → new path for moved files. Every finding carries the `label` its
 * allowance line must name; `unallowed` drops the ones the PR body allows.
 */
export function guard({ base, head, changed = [], renames = new Map(), config = DEFAULT_CONFIG }) {
  const { watched: WATCHED } = config;
  const failures = [];
  const baseGates = parse(base, GATES_FILE) ?? {};
  const headGates = parse(head, GATES_FILE) ?? {};
  for (const [gate, entry] of Object.entries(baseGates)) {
    const was = MODES.indexOf(entry?.mode);
    const now = Object.hasOwn(headGates, gate) ? headGates[gate]?.mode : undefined;
    if (MODES.indexOf(now) < was)
      failures.push({
        label: `${gate} mode`, // its own label: no file line can allow switching a gate down
        where: GATES_FILE,
        rule: 'mode-backwards',
        detail: `"${gate}" was ${entry.mode}, now ${now === undefined ? 'removed' : JSON.stringify(now)}`,
      });
  }
  const gateAdded = Object.keys(headGates).some((gate) => !Object.hasOwn(baseGates, gate));

  for (const file of base.keys()) {
    const watched = WATCHED.find((w) => w.match.test(file));
    if (watched?.removal && !head.has(file))
      failures.push({
        label: watched.label(watched.match.exec(file)),
        where: file,
        rule: 'removed',
        detail: 'The file is gone',
      });
  }

  for (const file of head.keys()) {
    const watched = WATCHED.find((w) => w.match.test(file));
    if (!watched) continue;
    const label = watched.label(watched.match.exec(file));
    const now = leaves(file, parse(head, file));
    if (!base.has(file)) {
      if (watched.newFile !== 'allowed' && !gateAdded)
        failures.push({ label, where: file, rule: 'new-file', detail: 'The merge base has no such file' });
      continue;
    }
    let was = leaves(file, parse(base, file));
    if (watched.renames) was = carryRenames(was, renames);
    const context = { path: file, was, now, changed, label };
    for (const [key, value] of now) {
      if (watched.keys && !watched.keys.test(key)) continue;
      const where = `${file} ${key}`;
      const keyLabel = watched.keyLabel?.(key, context) ?? label;
      if (!was.has(key))
        failures.push({ label: keyLabel, where, rule: 'key-added', detail: 'The merge base has no such key' });
      // A number on either side must be a number on both, and not higher.
      else if (
        (isNumber(was.get(key)) || isNumber(value)) &&
        !(isNumber(was.get(key)) && isNumber(value) && value <= was.get(key))
      )
        failures.push({
          label: keyLabel,
          where,
          rule: 'raised',
          detail: `Merge base ${isNumber(was.get(key)) ? was.get(key) : 'not a number'}, now ${isNumber(value) ? value : 'not a number'}`,
        });
    }
    failures.push(...(watched.extra?.(context) ?? []));
  }
  // A finding no line can allow (`allowable: false`) keeps its rule's own "Allow:" text.
  return failures.map((f) => (f.allowable === false ? f : { ...f, allow: f.allow ?? allowLine(f.label) }));
}

/** The findings the PR body does not allow: each needs its own `baseline-raise: <label> … — <reason>` line. */
export function unallowed(failures, body) {
  const allowed = (label) =>
    new RegExp(`^baseline-raise: ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — \\S`, 'm').test(body);
  return failures.filter((f) => f.allowable === false || !allowed(f.label));
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr ?? '').trim() || result.error}`);
  return result.stdout;
}

const isWatched = (config, file) => file === GATES_FILE || config.watched.some((w) => w.match.test(file));

/** The watched files of a commit. */
export function readBase(root, ref, config = DEFAULT_CONFIG) {
  const sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const files = git(root, ['ls-tree', '-r', '--name-only', sha, '--', ...config.roots]).split('\n');
  return new Map(
    files.filter((f) => isWatched(config, f)).map((file) => [file, git(root, ['show', `${sha}:${file}`])]),
  );
}

/** The watched files of the working tree. */
export function readHead(root, config = DEFAULT_CONFIG) {
  const files = config.roots
    .filter((path) => existsSync(join(root, path)))
    .flatMap((path) =>
      statSync(join(root, path)).isDirectory()
        ? readdirSync(join(root, path), { recursive: true }).map((name) => `${path}/${name.split('\\').join('/')}`)
        : [path],
    );
  return new Map(
    files.filter((f) => isWatched(config, f)).map((file) => [file, readFileSync(join(root, file), 'utf8')]),
  );
}

/** Old path → new path of every file git sees as moved between `ref` and HEAD (`-M`: 50% similar or more). */
export function readRenames(root, ref) {
  const lines = git(root, ['diff', '-M', '--name-status', '--diff-filter=R', ref, 'HEAD']).split('\n').filter(Boolean);
  return new Map(lines.map((line) => line.split('\t').slice(1)));
}

/** Whether the config module's text differs from the merge base's; a module the base lacks (its first PR) is new, not changed. */
function configChanged(root, ref, file) {
  const sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  if (spawnSync('git', ['cat-file', '-e', `${sha}:${file}`], { cwd: root }).status !== 0) return false;
  return git(root, ['show', `${sha}:${file}`]) !== readFileSync(join(root, file), 'utf8');
}

/** How long the one GitHub call may take before the guard fails as a gate that could not run. */
const PR_BODY_TIMEOUT_MS = 15_000;

async function prBody() {
  const { PR_BODY, GITHUB_REPOSITORY: repo, PR_NUMBER: pr, GITHUB_TOKEN: token } = process.env;
  if (PR_BODY !== undefined) return PR_BODY;
  if (!pr) return ''; // a local run has no PR: every finding shows
  const res = await globalThis.fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    signal: globalThis.AbortSignal.timeout(PR_BODY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`could not read the PR body: HTTP ${res.status}`);
  return (await res.json()).body ?? '';
}

/** The guard as a gate: `argv` is the CLI's arguments. */
export function run(root, argv, config = DEFAULT_CONFIG, configFile) {
  const baseAt = argv.indexOf('--base');
  const reported = new Set(argv.filter((a) => a.startsWith('--report=')).map((a) => a.slice('--report='.length)));
  return runGate({
    gate: 'baseline-guard',
    root,
    rules: { ...RULES, ...config.rules },
    mode: 'enforce', // DS-059 §4.1: enforced from its first day, it has no baseline of its own
    check: async () => {
      const ref = baseAt >= 0 ? argv[baseAt + 1] : git(root, ['merge-base', 'origin/main', 'HEAD']).trim();
      if (!ref) throw new Error('--base needs a commit');
      const base = readBase(root, ref, config);
      const head = readHead(root, config);
      const changed = git(root, ['diff', '--name-only', ref, 'HEAD']).split('\n').filter(Boolean);
      const failures = guard({ base, head, changed, renames: readRenames(root, ref), config });
      if (configFile && configChanged(root, ref, configFile))
        failures.push({
          label: 'guard-config',
          where: configFile,
          rule: 'config-changed',
          detail: 'The module differs from the merge base',
          allow: allowLine('guard-config'),
        });
      // No finding needs no body (and no network): the common case costs nothing.
      const open = failures.length ? unallowed(failures, await prBody()) : [];
      const soft = (f) =>
        f.rule !== 'mode-backwards' &&
        f.rule !== 'config-changed' && // the edited config must not be able to report itself away
        ([...reported].some((l) => f.label === l || f.label.startsWith(`${l} `)) || config.soft(f, { base, head }));
      return open.map((f) => (soft(f) ? { ...f, mode: 'report' } : f));
    },
  });
}
