#!/usr/bin/env node
/**
 * The `changes` job of `.github/workflows/ci.yml`.
 *
 * Works out which files a push or a pull request changed, hands them to `impact.mjs`, and writes the
 * domain booleans to `GITHUB_OUTPUT` and a human-readable summary to `GITHUB_STEP_SUMMARY`.
 *
 * Dependency-free on purpose: the `changes` job runs before any `npm ci`, so this has to be plain
 * Node with nothing but `node:child_process` and `node:fs`.
 *
 * # Working out the diff
 *
 * Two things have to be right, and both are easy to get wrong:
 *
 * 1. **A stacked pull request is compared against its own base**, not against `main`. This
 *    repository stacks: #197 is based on `gibby/qblive-architecture-docs`, not on the default
 *    branch. `github.event.pull_request.base.sha` is that base, so it is what this uses, and the
 *    merge base of it and the head is where the diff starts.
 * 2. **The clone is not shallow.** `actions/checkout` fetches one commit by default, which makes
 *    every `git diff` against a base either fail or silently report the wrong thing. `ci.yml`
 *    passes `fetch-depth: 0`, and if the base commit still is not present this script says so and
 *    fails safe rather than reporting a short list.
 *
 * Any failure to establish a diff — a missing base, an unborn branch, a force-push whose `before`
 * is gone, an unreadable lockfile — runs every domain. A wrong "nothing changed" is a scorer defect
 * shipped; a wrong "everything changed" is runner minutes.
 *
 * Usage:
 *   node scripts/ci/classify-impact.mjs                  # read the event from the environment
 *   node scripts/ci/classify-impact.mjs --files a.ts b.ts # classify an explicit list, for debugging
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { classify, DOMAINS, DOMAIN_LABELS, ruleFor } from './impact.mjs';

const ZERO_SHA = '0000000000000000000000000000000000000000';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** `true` when the object exists in this clone. */
function present(revision) {
  if (typeof revision !== 'string' || revision.length === 0 || revision === ZERO_SHA) return false;
  try {
    git(['cat-file', '-e', `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function readEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (path === undefined) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The two commits to diff, or `null` when they cannot be established.
 *
 * Returns `{ base, head, description }`. `base` is a commit, never a range.
 */
function commitRange() {
  const event = readEvent();
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';

  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const base = event.pull_request?.base?.sha;
    const head = event.pull_request?.head?.sha ?? 'HEAD';
    if (!present(base)) return null;
    // The head sha is the pull request's own tip. On a `pull_request` event the checked-out ref is
    // the merge commit, whose second parent is that tip, so it is present in the clone.
    const headRevision = present(head) ? head : 'HEAD';
    let start = base;
    try {
      start = git(['merge-base', base, headRevision]).trim();
    } catch {
      // Not an ancestor relationship this clone can see. `base` on its own still gives a superset
      // of the pull request's changes, which errs toward more testing.
    }
    return {
      base: start,
      head: headRevision,
      description: `pull request #${event.number ?? event.pull_request?.number ?? '?'} against ${
        event.pull_request?.base?.ref ?? 'its base'
      }`,
    };
  }

  if (eventName === 'push') {
    const head = present(event.after) ? event.after : 'HEAD';
    const reference = process.env.GITHUB_REF_NAME ?? 'this branch';
    if (event.created !== true && present(event.before)) {
      return { base: event.before, head, description: `push to ${reference}` };
    }
    // A new branch, or a force-push over a commit this clone no longer has. The default branch is
    // the next best base: for a branch pushed for the first time it is the right one, and for a
    // stacked branch it gives a superset of that branch's own changes, which errs toward testing
    // more. If even that is not reachable, the caller runs everything.
    const base = defaultBranchBase(head);
    if (base === null) return null;
    return { base, head, description: `first push of ${reference}, compared with the default branch` };
  }

  return null;
}

/** The merge base of the default branch and `head`, or `null`. */
function defaultBranchBase(head) {
  const event = readEvent();
  const name = event.repository?.default_branch ?? 'main';
  for (const candidate of [`origin/${name}`, `refs/remotes/origin/${name}`, name]) {
    try {
      return git(['merge-base', candidate, head]).trim();
    } catch {
      // Not a ref this clone has. Try the next spelling.
    }
  }
  return null;
}

/** The changed paths, or `null` to mean "could not be determined". */
function changedPaths(range) {
  if (range === null) return null;
  try {
    // `--no-renames` so a moved file reports both its old and its new path: the old path may be the
    // one that carries a domain, and a rename can break an import at either end.
    const output = git(['diff', '--name-only', '--no-renames', '-z', `${range.base}`, `${range.head}`]);
    return output.split('\0').filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

/** A parsed lockfile at one revision, or `null`. */
function lockfileAt(revision) {
  try {
    return JSON.parse(git(['show', `${revision}:package-lock.json`]));
  } catch {
    return null;
  }
}

function main() {
  const explicit = process.argv.indexOf('--files');
  let paths;
  let description;
  let lockfiles = { base: null, head: null };

  if (explicit !== -1) {
    paths = process.argv.slice(explicit + 1);
    description = 'an explicit file list';
    if (paths.includes('package-lock.json')) {
      // Debugging aid: compare the working tree against its upstream.
      lockfiles = { base: lockfileAt('HEAD'), head: lockfileAt('HEAD') };
    }
  } else {
    const range = commitRange();
    paths = changedPaths(range);
    description = range?.description ?? 'an undeterminable range';
    if (paths !== null && paths.includes('package-lock.json')) {
      lockfiles = { base: lockfileAt(range.base), head: lockfileAt(range.head) };
    }
  }

  let result;
  if (paths === null) {
    result = classify([]);
    for (const domain of DOMAINS) result.domains[domain] = true;
    result['docs-only'] = false;
    result.any = true;
    result.notes.push(
      'The changed files could not be determined, so every domain runs. Check that ci.yml still ' +
        'checks out with fetch-depth: 0.',
    );
    paths = [];
  } else {
    result = classify(paths, lockfiles);
  }

  report(result, description);
  write(result);
}

function report(result, description) {
  const lines = [];
  lines.push('# Change impact');
  lines.push('');
  lines.push(`Classified ${result.files.length} changed file(s) from ${description}.`);
  lines.push('');
  lines.push('| Domain | Runs | What it protects |');
  lines.push('| --- | --- | --- |');
  for (const domain of DOMAINS) {
    lines.push(`| \`${domain}\` | ${result.domains[domain] ? '**yes**' : 'no'} | ${DOMAIN_LABELS[domain]} |`);
  }
  lines.push('');

  const on = DOMAINS.filter((domain) => result.domains[domain]);
  if (on.length === 0) {
    lines.push(
      result['docs-only']
        ? 'Nothing that changed is code. No validation job runs, and `verify` reports success.'
        : 'No job in this workflow protects anything that changed — see the file table below. ' +
            '`verify` reports success.',
    );
    lines.push('');
  } else {
    lines.push('## Why each domain runs');
    lines.push('');
    for (const domain of on) {
      const files = result.because[domain];
      const shown = files.slice(0, 12);
      const rest = files.length - shown.length;
      lines.push(
        `* **${domain}** — ${shown.map((file) => `\`${file}\``).join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`,
      );
    }
    lines.push('');
  }

  if (result.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const note of result.notes) lines.push(`* ${note}`);
    lines.push('');
  }

  if (result.unclassified.length > 0) {
    lines.push('## Unclassified paths');
    lines.push('');
    lines.push('These matched no rule in `scripts/ci/impact.mjs`, so every domain ran. Add a rule for them.');
    lines.push('');
    for (const file of result.unclassified) lines.push(`* \`${file}\``);
    lines.push('');
  }

  if (result.files.length > 0) {
    lines.push('<details><summary>Every changed file, and the rule that classified it</summary>');
    lines.push('');
    lines.push('| File | Rule | Domains |');
    lines.push('| --- | --- | --- |');
    for (const file of result.files.slice(0, 200)) {
      const rule = file === 'package-lock.json' ? undefined : ruleFor(file);
      const matched = file === 'package-lock.json' ? 'the lockfile analyser' : (rule?.glob ?? '*(none)*');
      const domains =
        file === 'package-lock.json'
          ? 'see Notes'
          : rule === undefined
            ? 'all (fail-safe)'
            : rule.domains.length === 0
              ? '*(none)*'
              : rule.domains.join(', ');
      lines.push(`| \`${file}\` | \`${matched}\` | ${domains} |`);
    }
    if (result.files.length > 200) lines.push(`| … and ${result.files.length - 200} more | | |`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  const summary = lines.join('\n');
  // The log gets a compact form, because a job log is read by scrolling.
  console.log('Change impact');
  console.log('');
  for (const domain of DOMAINS) {
    console.log(`  ${domain.padEnd(22)} ${result.domains[domain] ? 'yes' : 'no'}`);
  }
  console.log('');
  for (const note of result.notes) console.log(`  note: ${note}`);
  for (const file of result.unclassified)
    console.log(`  ::warning::Unclassified path, ran everything: ${file}`);

  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
}

function write(result) {
  const outputs = DOMAINS.map((domain) => `${domain}=${result.domains[domain]}`);
  outputs.push(`docs-only=${result['docs-only']}`);
  outputs.push(`affected=${DOMAINS.filter((domain) => result.domains[domain]).join(' ')}`);
  outputs.push(`file-count=${result.files.length}`);
  for (const line of outputs) console.log(`output: ${line}`);
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${outputs.join('\n')}\n`);
  }
}

main();
