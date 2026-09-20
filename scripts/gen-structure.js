#!/usr/bin/env node
/**
 * Writes STRUCTURE.md and scripts/scaffold-provenlens.sh from the files git tracks.
 *
 *   node scripts/gen-structure.js            rewrite both
 *   node scripts/gen-structure.js --check    exit 1 and say which one is out of date
 *
 * Both exist for someone who has to set this project up on a machine that
 * cannot clone it and will paste the code in by hand: one says where
 * everything goes and what it is, the other creates the tree empty. A list of
 * paths written by hand is wrong one pull request later, and nothing says so,
 * so both are generated and a test runs `--check`. Neither output carries a
 * commit hash or a line count -- anything that changes without the file set
 * changing would fail that check on every commit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUTS = { doc: 'STRUCTURE.md', script: 'scripts/scaffold-provenlens.sh' };

/** What a machine needs for each purpose. Patterns, so a new file under src/ is in without an edit. */
export const TIERS = {
  runtime: ['package.json', 'yarn.lock', 'bin/', 'src/'],
  tests: ['package.json', 'yarn.lock', 'bin/', 'src/', 'test/', '__fixtures__/'],
};
export const inTier = (path, tier) =>
  tier === 'all' || TIERS[tier].some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));

/** Tracked files with their modes, in an order no locale can change. */
export function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const [meta, path] = row.split('\t');
      return { path, executable: meta.startsWith('100755') };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------------------------------------------------------------------------
// What each file is. Kept here, beside the list it describes, so adding a file
// and saying what it is are one edit. A file with no entry is listed without a
// description and named on stderr.
// ---------------------------------------------------------------------------
const FILES = {
  '.gitignore': 'Keeps `node_modules/`, indexes and scratch files out of the repository.',
  'LICENSE': 'MIT.',
  'README.md': 'What the tool is, how its numbers were measured, every command, the architecture and the known limits.',
  'SETUP.md': 'Step-by-step setup from a bare machine, with what each step should print.',
  'SETUP.vi.md': 'The same guide in Vietnamese.',
  'STRUCTURE.md': 'This file. Generated.',
  'action.yml': 'Composite GitHub Action: reports what a pull request reaches and which tests cover it.',
  'package.json': 'The manifest: four runtime dependencies pinned to exact versions, the Node floor, the test script.',
  'yarn.lock': 'Integrity-hashed lockfile. Never typed by hand -- see *What not to type*.',

  '.github/dependabot.yml': 'Weekly dependency and action updates; the two tree-sitter packages move only as a pair.',
  '.github/pull_request_template.md': 'What a pull request has to say before review.',
  '.github/workflows/tests.yml': 'The suite on Linux (Node 22 and 24), macOS and Windows.',
  '.github/workflows/resolution.yml': 'provenlens indexes itself and must stay above 90%.',
  '.github/workflows/review.yml': "The README's test count matches the suite; a resolver change comes with a test; automated review.",
  '.github/workflows/security.yml': 'CodeQL, lockfile audit, dependency review, and a check that nothing in the source can reach the network.',
  '.github/workflows/hygiene.yml': '`.gitignore` still covers what the tool writes; no index, session or vendor directory is committed.',
  '.github/workflows/blast-radius.yml': 'Runs `action.yml` on every pull request.',

  'bin/provenlens.js': 'The CLI: every command, and the index lock around the ones that write.',

  'src/lang.js': 'The four languages: extensions and grammar for each, and the tree-sitter parser loader.',
  'src/quiet.js': "Imported first by every entry point: silences Node's experimental-feature notice so the shebang stays plain.",
  'src/heap.js': 'Re-executes indexing commands with a larger V8 heap; a large repository dies against the default.',
  'src/db.js': 'The SQLite schema and its version, opening and resetting an index, and the one sentence a too-old Node gets.',
  'src/project.js': "Which files are this project's source: asks git, honours `.gitignore`, refuses dependency trees. Also where the index lives and the lock on it.",
  'src/indexer.js': 'The pipeline: discover, parse, extract into rows, read dependency types, run each resolver, run the binding plugins. Incremental by content hash.',
  'src/watch.js': '`sync -w`: re-index shortly after files stop changing.',
  'src/workspace.js': 'Several indexed repositories treated as one: finding a symbol, and a path, across them.',

  'src/extract/index.js': 'Language to extractor.',
  'src/extract/java.js': 'Walks the Java AST into flat records: symbols, call sites, imports, locals, annotations.',
  'src/extract/ruby.js': 'The same for Ruby, leaning on Rails conventions and the few things Ruby does declare.',
  'src/extract/typescript.js': 'The same for TypeScript, TSX and JavaScript -- one extractor, the node types overlap.',

  'src/resolve/java.js': 'Java call sites into edges: receiver types, overloads by arity, static imports, interface to implementation.',
  'src/resolve/ruby.js': 'Ruby call sites into edges, at lower confidence; proves when a receiver is declared nowhere.',
  'src/resolve/typescript.js': 'TypeScript and JavaScript: mostly module resolution -- barrels, tsconfig paths, package exports.',

  'src/ambient.js': "`.d.ts` files of installed packages, read so a chain can be typed through a library.",
  'src/jvm.js': 'Signatures and fields of JDK and jar classes, read with `javap`: the Java half of the same idea.',
  'src/schema/rails.js': '`db/schema.rb` columns as model attributes, so `account.uri` has something to land on.',

  'src/bindings/index.js': 'Runs the plugins in one transaction and joins providers to consumers on the string they share.',
  'src/bindings/text.js': 'Helpers the plugins share: line numbers without re-splitting a file, annotation attributes.',
  'src/bindings/http.js': 'Routes served (Spring, Rails, Express, NestJS) and the clients that call them.',
  'src/bindings/kafka.js': 'Topic producers and listeners.',
  'src/bindings/sqs.js': 'Queue producers and listeners.',
  'src/bindings/mybatis.js': 'Mapper interface methods and the XML statements that actually run.',
  'src/bindings/camel.js': 'Camel routes joined by endpoint URI.',
  'src/bindings/springevent.js': 'Event publishers and the listeners that take the same type.',
  'src/bindings/graphql.js': 'Schema fields and the resolvers that implement them.',
  'src/bindings/grpc.js': '`.proto` services, the classes that implement them and the stubs that call them.',
  'src/bindings/flyway.js': 'Migrations and the entities whose tables they change.',

  'src/query.js': 'Search, callers, callees, blast radius, `affected`, shortest path, project statistics, what counts as a test file.',
  'src/unlinked.js': 'Same-named call sites the resolver declined to link, listed beside the edges as candidates.',
  'src/insight.js': '`dead`, `cycles` and `hotspots`.',
  'src/why.js': "One symbol's evidence: which links rest on a declaration and which on a convention.",
  'src/doctor.js': 'Why a repository resolves as it does, and what would change it.',
  'src/format.js': 'The text every front end prints: explore, node, callers, impact, affected, why, Mermaid.',

  'src/mcp.js': 'MCP server over stdio, hand-rolled JSON-RPC; the five tools.',
  'src/server.js': 'Local web UI server: token, one repository or many, JSON API.',
  'src/ui/app.html': 'The web UI, one self-contained page.',
  'src/hook.js': 'What the Claude Code hooks say after an edit and at session start.',
  'src/install.js': 'Registers and removes the MCP server and the hooks in agent configs, with a preview and a `.bak`.',

  'scripts/ast.js': "Dumps a file's tree-sitter AST -- what every extractor is written against.",
  'scripts/bench.js': 'Indexes a repository into a scratch database and reports in-repo resolution and the floor.',
  'scripts/protect-main.sh': 'The branch protection `main` should have, as one reviewable command.',
  'scripts/gen-structure.js': 'Writes this file and the scaffold script from the files git tracks.',
  'scripts/scaffold-provenlens.sh': 'Creates this tree empty. Generated.',

  'test/helpers.js': 'Builds a throwaway index per fixture; shared by the suites.',
  'test/java.test.js': 'Java extraction and resolution on the `java` fixture.',
  'test/ruby.test.js': 'Ruby: inflection, Rails conventions, resolution on `ruby`.',
  'test/typescript.test.js': 'TypeScript and JavaScript: type normalisation and module resolution on `ts`.',
  'test/bindings.test.js': 'The binding plugins on `bindings`.',
  'test/http-routes.test.js': 'HTTP routes and their clients.',
  'test/schema.test.js': 'Rails schema columns.',
  'test/mixed.test.js': 'Every fixture indexed as one repository: resolvers must not wipe each other.',
  'test/multirepo.test.js': 'Three services that meet only through a queue name.',
  'test/vendored.test.js': 'A repository that keeps its own source inside `node_modules`.',
  'test/insight.test.js': 'Hotspots, dead code, cycles.',
  'test/doctor.test.js': '`doctor` findings.',
  'test/hook.test.js': 'What the edit hook tells Claude.',
  'test/index-lock.test.js': 'Two indexers on one repository.',
  'test/server.test.js': 'The web UI server: token, Host header, API.',
  'test/uninstall.test.js': 'Taking the hooks and the MCP entry back out of agent configs.',
  'test/regressions.test.js': 'Every defect found in the field, each with the probe that found it.',
  'test/core-fixes.test.js': "The full review's defects in the core.",
  'test/bindings-review.test.js': "The full review's defects in the binding plugins.",
  'test/java-review.test.js': "The full review's defects in Java.",
  'test/ruby-review.test.js': "The full review's defects in Ruby.",
  'test/typescript-review.test.js': "The full review's defects in TypeScript.",
  'test/jvm-fields.test.js': 'javap fields, and a JDK class asked for twice.',
  'test/unlinked.test.js': 'Unlinked same-named call sites on every answer about callers.',
  'test/runtime.test.js': 'The Node floor and the plain shebang.',
  'test/structure.test.js': 'This file and the scaffold script match the repository; the runtime tier really runs.',
};

const FIXTURES = {
  java: 'Spring: controller, service interface, implementation, repository interface.',
  ruby: 'Rails: model, concern, service object, controller.',
  ts: 'TypeScript and JavaScript: barrel files, tsconfig aliases, constructor injection.',
  bindings: 'MyBatis, Camel, SQS, Kafka, Spring events, GraphQL, gRPC, Flyway.',
  vendored: 'A repository that keeps its own source inside `packages/node_modules`.',
  java2: 'What the review found in Java: static imports, method references, enum constants, comments in argument lists.',
  ruby2: 'What the review found in Ruby: a reopened model, `class << self`, writers, `Struct.new`, callbacks.',
  ts2: 'What the review found in TypeScript: destructuring, arrow fields, `export * as`, tsconfig `extends`, `exports` maps.',
  bindings2: 'What the review found in the plugins: class-level route prefixes, multi-line topics, commented-out SQL, Rails `namespace`.',
  unlinked: 'An untyped receiver and two `save` methods: the call the resolver declines, listed as a candidate.',
};

const AREAS = [
  ['bin/', 'The command-line entry point.'],
  ['src/', 'The tool: discovery, extraction, resolution, bindings, queries and the three front ends.'],
  ['test/', 'The suite, run with `yarn test`. One file per subject.'],
  ['__fixtures__/', 'Small repositories the suite indexes. Source code in four languages, never executed.'],
  ['scripts/', 'Developer tools: AST dump, benchmark, branch protection, this generator and its scaffold.'],
  ['.github/', 'Continuous integration, Dependabot and the pull-request template.'],
  ['(root)', 'Manifest, lockfile, licence and the three documents.'],
];

const SRC_GROUPS = [
  ['Core and pipeline', ['src/lang.js', 'src/quiet.js', 'src/heap.js', 'src/db.js', 'src/project.js', 'src/indexer.js', 'src/watch.js', 'src/workspace.js']],
  ['Extractors -- source text into flat records', (p) => p.startsWith('src/extract/')],
  ['Resolvers -- call sites into edges, or into a reason', (p) => p.startsWith('src/resolve/')],
  ['Types read from outside the project', ['src/ambient.js', 'src/jvm.js', 'src/schema/rails.js']],
  ['Binding plugins -- what frameworks wire by string', (p) => p.startsWith('src/bindings/')],
  ['Reading the graph', ['src/query.js', 'src/unlinked.js', 'src/insight.js', 'src/why.js', 'src/doctor.js', 'src/format.js']],
  ['Front ends and installation', ['src/mcp.js', 'src/server.js', 'src/ui/app.html', 'src/hook.js', 'src/install.js']],
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function tree(paths, name) {
  const root = new Map();
  for (const p of paths) {
    let at = root;
    for (const part of p.split('/')) {
      if (!at.has(part)) at.set(part, new Map());
      at = at.get(part);
    }
  }
  const lines = [`${name}/`];
  const walk = (node, prefix) => {
    // Folders before files, each in plain code-unit order.
    const entries = [...node.entries()].sort(([a, an], [b, bn]) => (bn.size > 0) - (an.size > 0) || (a < b ? -1 : a > b ? 1 : 0));
    entries.forEach(([part, child], i) => {
      const last = i === entries.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${part}${child.size ? '/' : ''}`);
      if (child.size) walk(child, prefix + (last ? '    ' : '│   '));
    });
  };
  walk(root, '');
  return lines.join('\n');
}

const table = (rows) => ['| File | What it is |', '|---|---|', ...rows.map(([p, d]) => `| \`${p}\` | ${d || '--'} |`)].join('\n');
const count = (files, prefix) => files.filter((f) => (prefix === '(root)' ? !f.path.includes('/') : f.path.startsWith(prefix))).length;

export function render() {
  const files = trackedFiles();
  const paths = files.map((f) => f.path);
  const dirs = new Set();
  for (const p of paths) for (let d = dirname(p); d !== '.'; d = dirname(d)) dirs.add(d);
  const n = { all: paths.length, runtime: paths.filter((p) => inTier(p, 'runtime')).length, tests: paths.filter((p) => inTier(p, 'tests')).length };
  const undescribed = paths.filter((p) => !p.startsWith('__fixtures__/') && !(p in FILES));
  const described = (list) => list.map((p) => [p, FILES[p]]);

  const srcSections = SRC_GROUPS.map(([title, pick]) => {
    const list = typeof pick === 'function' ? paths.filter(pick) : pick.filter((p) => paths.includes(p));
    return `**${title}**\n\n${table(described(list))}`;
  });
  const grouped = new Set(SRC_GROUPS.flatMap(([, pick]) => (typeof pick === 'function' ? paths.filter(pick) : pick)));
  const stray = paths.filter((p) => p.startsWith('src/') && !grouped.has(p));
  if (stray.length) srcSections.push(`**Not yet grouped**\n\n${table(described(stray))}`);

  const fixtureNames = [...new Set(paths.filter((p) => p.startsWith('__fixtures__/')).map((p) => p.split('/')[1]))];

  const doc = `# provenlens -- repository structure

Where every file lives, what it is, and a script that recreates the tree empty. **Structure only --
no file contents**, so this page is safe to paste anywhere. It is written for someone who has to set
the project up on a machine that cannot clone it, and will paste the code in by hand.
${n.all} tracked files in ${dirs.size} directories. Generated by \`scripts/gen-structure.js\`; a test
fails when it no longer matches the repository. *Setting up from a normal clone is
[SETUP.md](SETUP.md).*

## The shape in one paragraph

A repository is **discovered** -- \`project.js\` asks git what is source -- and each file is parsed by
a tree-sitter grammar and **extracted** into flat records: symbols, call sites, imports, locals
(\`extract/\`). Those land in **SQLite** (\`db.js\`, \`indexer.js\`). One **resolver** per language turns
each call site into an edge, or into an unresolved row that says why (\`resolve/\`), reading types
from dependencies where it can (\`ambient.js\`, \`jvm.js\`, \`schema/rails.js\`). **Binding plugins**
then join what frameworks wire by string rather than by call (\`bindings/\`). Everything after that
only reads: queries, the unlinked candidates, insights and explanations (\`query.js\`, \`unlinked.js\`,
\`insight.js\`, \`why.js\`, \`doctor.js\`), formatted once (\`format.js\`) for three front ends -- the CLI
(\`bin/\`), the MCP server (\`mcp.js\`) and the local web UI (\`server.js\`, \`ui/app.html\`).

## How much you need to copy

| To | Copy | Files |
|---|---|---:|
| **Run it** -- every command: \`init\`, \`explore\`, \`callers\`, \`serve\`, \`mcp\` | \`package.json\`, \`yarn.lock\`, \`bin/\`, \`src/\` | **${n.runtime}** |
| **Run the tests** as well | the above, plus \`test/\` and \`__fixtures__/\` | ${n.tests} |
| **Everything**: CI, benchmark, documents | the whole tree | ${n.all} |

The first row is proved, not assumed: \`test/structure.test.js\` copies exactly those files into an
empty folder and indexes a fixture with them.

### What not to type

- **\`yarn.lock\`** -- copy it byte for byte or leave it out. The four dependencies are pinned to exact
  versions and bring nothing with them, so \`yarn install\` writes an equivalent file; use
  \`yarn install --frozen-lockfile\` from then on.
- **\`node_modules/\`** and the grammars (\`*.wasm\`) come from \`yarn install\`. They are never copied.
- **\`.provenlens/\`** is an index, built by \`provenlens init\` in the repository you point it at.

## Top-level areas

| Area | Holds | Files |
|---|---|---:|
${AREAS.map(([a, d]) => `| \`${a}\` | ${d} | ${count(files, a)} |`).join('\n')}

## Full tree

\`\`\`
${tree(paths, 'provenlens')}
\`\`\`

## File by file

### \`bin/\` and \`src/\` -- what runs

${table(described(paths.filter((p) => p.startsWith('bin/'))))}

${srcSections.join('\n\n')}

### \`scripts/\`

${table(described(paths.filter((p) => p.startsWith('scripts/'))))}

### \`test/\`

${table(described(paths.filter((p) => p.startsWith('test/'))))}

### \`__fixtures__/\`

Each folder is a small repository the suite indexes. The files are ordinary source in the language
named; the tree above lists them all.

| Fixture | Files | What it simulates |
|---|---:|---|
${fixtureNames.map((f) => `| \`${f}\` | ${count(files, `__fixtures__/${f}/`)} | ${FIXTURES[f] || '--'} |`).join('\n')}

### \`.github/\` and the root

${table(described(paths.filter((p) => p.startsWith('.github/') || !p.includes('/'))))}

## Creating this structure with one command

From a checkout, for the files needed to run it:

\`\`\`bash
bash scripts/scaffold-provenlens.sh --runtime ~/provenlens
\`\`\`

\`--tests\` adds \`test/\` and \`__fixtures__/\`; with no flag it creates all ${n.all} files. Every file is
created empty, nothing that exists is overwritten -- so it is safe to run again after you have
started pasting -- and the ${files.filter((f) => f.executable).length} files git marks executable are made executable, which the symlink in
[SETUP.md](SETUP.md) step 3 depends on. The script needs nothing but \`bash\`: with no checkout to run
it from, paste the script itself into a file on the target machine first.

## After pasting the code

Catch a slip of the hand before anything runs -- this parses every file and executes none:

\`\`\`bash
find bin src scripts test -name '*.js' -print0 | xargs -0 -n1 node --check
\`\`\`

Install the four dependencies (\`--frozen-lockfile\` only if \`yarn.lock\` was copied exactly):

\`\`\`bash
yarn install
\`\`\`

\`\`\`bash
node bin/provenlens.js --version
\`\`\`

That prints \`0.1.0\`. With the test tier in place, \`yarn test\` must pass in full. From there, continue
at step 3 of [SETUP.md](SETUP.md).

## Checking a hand copy against the original

On the machine that has the real repository, outside the tree so it is not mistaken for source:

\`\`\`bash
git ls-files -z | xargs -0 shasum -a 256 > ../provenlens.sha256
\`\`\`

Carry that one file across, and in the copy:

\`\`\`bash
shasum -a 256 -c ../provenlens.sha256 | grep -v ': OK$'
\`\`\`

It prints nothing when every file matches. A file missing because you stopped at the runtime tier
is reported as such and can be ignored; an editor that saved Windows line endings shows up as a
mismatch. On Linux the command is \`sha256sum\`.

## Keeping this page true

\`\`\`bash
node scripts/gen-structure.js
\`\`\`

rewrites this page and the scaffold script from \`git ls-files\`; run it after \`git add\`-ing or
removing a file. \`node scripts/gen-structure.js --check\` is what the test runs. What a file *is*
lives in the table at the top of that generator, beside the list it describes.
`;

  const script = `#!/usr/bin/env bash
# scaffold-provenlens.sh -- create the folder tree and empty files of provenlens.
#
#   bash scaffold-provenlens.sh [--runtime | --tests] [target-dir]     (default: ./provenlens)
#
#   --runtime   only what is needed to run it: package.json, yarn.lock, bin/, src/   (${n.runtime} files)
#   --tests     that, plus test/ and __fixtures__/                                  (${n.tests} files)
#   (no flag)   everything git tracks                                               (${n.all} files)
#
# Structure only: every file is created empty. Nothing is overwritten, so it is safe to re-run
# after you have started filling files in. The files git marks executable are made executable.
# GENERATED by scripts/gen-structure.js from \`git ls-files\` -- edit that, not this.
set -euo pipefail

tier=all
root=provenlens
for arg in "$@"; do
  case "$arg" in
    --runtime) tier=runtime ;;
    --tests) tier=tests ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \\{0,1\\}//'; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) root=$arg ;;
  esac
done

wanted() {
  case "$tier" in
    all) return 0 ;;
    runtime) case "$1" in ${TIERS.runtime.map((p) => (p.endsWith('/') ? `${p}*` : p)).join('|')}) return 0 ;; esac ;;
    tests) case "$1" in ${TIERS.tests.map((p) => (p.endsWith('/') ? `${p}*` : p)).join('|')}) return 0 ;; esac ;;
  esac
  return 1
}

mkdir -p "$root"
cd "$root"

created=0; existing=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  wanted "$f" || continue
  mkdir -p "$(dirname "$f")"
  if [ -e "$f" ]; then existing=$((existing+1)); else : > "$f"; created=$((created+1)); fi
done <<'PATHS'
${paths.join('\n')}
PATHS

for f in ${files.filter((f) => f.executable).map((f) => f.path).join(' ')}; do
  if [ -e "$f" ]; then chmod +x "$f"; fi
done

echo "$root ($tier): $created file(s) created, $existing already present"
`;

  return { doc, script, undescribed };
}

// ---------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const { doc, script, undescribed } = render();
  // A Windows checkout may hold CRLF; the content is what is compared.
  const same = (path, text) => {
    try { return readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n') === text; } catch { return false; }
  };
  const stale = [[OUTPUTS.doc, doc], [OUTPUTS.script, script]].filter(([p, t]) => !same(p, t));
  for (const p of undescribed) process.stderr.write(`no description for ${p} -- add one to FILES in scripts/gen-structure.js\n`);
  if (check) {
    for (const [p] of stale) process.stderr.write(`${p} is out of date -- run: node scripts/gen-structure.js\n`);
    process.exit(stale.length ? 1 : 0);
  }
  for (const [p, t] of stale) { writeFileSync(join(ROOT, p), t); console.log(`wrote ${p}`); }
  if (!stale.length) console.log('already up to date');
}
