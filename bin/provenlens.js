#!/usr/bin/env -S node --no-warnings
import { ensureHeadroom } from '../src/heap.js';

// V8's own cap is what a large repository dies against, and only a fresh
// process can raise it. The modules below are hoisted and have already been
// evaluated by the time this runs -- that costs a re-import in the child and
// is worth it, because the alternative is indexing against a 4 GB ceiling.
ensureHeadroom();

import { Command } from 'commander';
import { resolve, join, basename } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { openDb, openProject, getMeta } from '../src/db.js';
import { findProjectRoot, dbPathFor, INDEX_DIR, acquireIndexLock, repoRelative } from '../src/project.js';
import { explainSymbol } from '../src/why.js';
import { indexProject } from '../src/indexer.js';
import {
  searchSymbols,
  projectStats,
  callersOf,
  calleesOf,
  impactOf,
  affectedBy,
  isTestPath,
  graphAround,
  topHubs,
} from '../src/query.js';
import { formatExplore, formatNode, formatImpact, formatRelations, formatAffected, toMermaid, formatPath, pathLines, symbolLabel, formatWhy } from '../src/format.js';
import { IMPLEMENTED_LANGUAGES } from '../src/extract/index.js';
import { openWorkspace, locateSymbol, pathAcross } from '../src/workspace.js';

const program = new Command();

/** Machine-readable output, so provenlens can feed other tools. */
function emitJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

/** The fields worth handing to another program; the rest is internal. */
function publicSymbol(s) {
  return {
    id: s.id,
    name: s.name,
    fqn: s.fqn,
    kind: s.kind,
    file: s.file_path,
    line: s.start_line,
    endLine: s.end_line,
    lang: s.lang,
    signature: s.signature,
    ...(s.edge_kind ? { edge: s.edge_kind, via: s.via, confidence: s.confidence } : {}),
    ...(s.lines?.length ? { callLines: s.lines } : {}),
  };
}

function readStdin() {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buffer += chunk));
    process.stdin.on('end', () => done(buffer));
  });
}

function die(msg) {
  console.error(`provenlens: ${msg}`);
  process.exit(1);
}

/** Opens the nearest indexed project, or explains how to make one. */
function useProject(pathArg, { needsData = true } = {}) {
  const root = findProjectRoot(pathArg ? resolve(pathArg) : process.cwd());
  if (!root) die(`no ${INDEX_DIR}/ found here or in any parent. Run \`provenlens init\` first.`);
  const { db, staleSchema } = openProject(dbPathFor(root));
  if (staleSchema && needsData) {
    die('index was built by an older version and has been reset. Run `provenlens index`.');
  }
  return { root, db };
}

/**
 * Like useProject, but a folder of indexed checkouts counts too: every repo
 * one level down becomes part of the scope, the same rule `serve` follows.
 */
function useScope(pathArg) {
  const start = pathArg ? resolve(pathArg) : process.cwd();
  if (findProjectRoot(start)) {
    const { root, db } = useProject(pathArg);
    return [{ id: 0, name: basename(root), root, db }];
  }
  const projects = openWorkspace(start);
  if (!projects.length) {
    die(`no ${INDEX_DIR}/ found here, in any parent, or one level down. Run \`provenlens init\` first.`);
  }
  return projects;
}

/** Finds the one repository in scope that knows this name, or dies usefully. */
function pickAcross(projects, name) {
  const found = locateSymbol(projects, name);
  if (!found) die(`no symbol matches "${name}" in ${projects.length} repositor${projects.length === 1 ? 'y' : 'ies'}.`);
  if (projects.length > 1) {
    // Same-scored hits in other repos deserve a mention, not a guess.
    const elsewhere = projects
      .filter((p) => p.id !== found.project.id)
      .filter((p) => (locateSymbol([p], name)?.hit.score ?? -1) >= found.hit.score)
      .map((p) => p.name);
    if (elsewhere.length) {
      console.error(`note: "${name}" also matches in ${elsewhere.join(', ')} — using ${found.project.name}.`);
    }
  }
  return found;
}

/** Resolves a user-typed name to exactly one symbol, or reports the ambiguity. */
function pickSymbol(db, name) {
  const matches = searchSymbols(db, name, { limit: 10 });
  if (!matches.length) die(`no symbol matches "${name}".`);
  if (matches.length > 1 && matches[0].score === matches[1].score) {
    console.error(`Ambiguous "${name}" — ${matches.length} matches:`);
    for (const m of matches) console.error(`  ${m.fqn ?? m.name}  (${m.file_path}:${m.start_line})`);
    console.error('\nRe-run with a fully qualified name, e.g. Type#method.');
    process.exit(1);
  }
  return matches[0];
}

/**
 * Every command that writes the index goes through here.
 *
 * Two index runs on one database do not merely contend for the write lock --
 * they contend over the CONTENT: one rebuilds the symbols the other is still
 * resolving edges against, and the loser dies on a foreign-key violation with
 * the index half written. The lock lives at the CLI, because this is where a
 * project's own `.provenlens/` is the database being written; the library takes
 * whatever database it is handed, which a benchmark or a test may keep
 * somewhere else entirely.
 */
async function withIndexLock(root, run) {
  let release;
  try {
    release = acquireIndexLock(root);
  } catch (err) {
    if (err?.code === 'PROVENLENS_LOCKED') die(err.message);
    throw err;
  }
  try {
    return await run();
  } finally {
    release();
  }
}

function reportIndex(stats) {
  console.log(
    `indexed ${stats.parsed} file(s), ${stats.symbols} symbol(s)` +
      (stats.skipped ? `, ${stats.skipped} unchanged` : '') +
      (stats.removed ? `, ${stats.removed} removed` : ''),
  );
  if (stats.unparsable) {
    console.log(
      `${stats.unparsable} file(s) too large or malformed to parse — their calls are not in the graph`,
    );
  }
  if (stats.packed) {
    console.log(
      `${stats.packed} file(s) refused as machine-packed (a bundle or minified file, not source)`,
    );
  }
  if (stats.pending) {
    const pendingLangs = Object.keys(stats.byLang).filter((l) => !IMPLEMENTED_LANGUAGES.includes(l));
    if (pendingLangs.length) {
      console.log(
        `${stats.pending} file(s) discovered but not parsed — no extractor yet for: ${pendingLangs.join(', ')}`,
      );
    }
  }
  for (const [lang, r] of Object.entries(stats.resolve ?? {})) {
    // Library calls are excluded from the denominator: they are not misses,
    // and counting them makes the figure mostly a measure of framework use.
    const inRepo = r.direct + r.viaImpl + r.uniqueName + r.unresolved;
    const pct = inRepo ? (((r.direct + r.viaImpl + r.uniqueName) / inRepo) * 100).toFixed(1) : '0.0';
    console.log(
      `${lang}: ${r.direct} direct, ${r.viaImpl} via impl, ${r.uniqueName} by name, ` +
        `${r.unresolved} missed, ${r.external ?? 0} library (${pct}% of in-repo calls linked)`,
    );
  }
  for (const [plugin, b] of Object.entries(stats.bindings ?? {})) {
    console.log(
      `${plugin}: ${b.provider ?? 0} provider(s), ${b.consumer ?? 0} consumer(s), ${b.wired} wired`,
    );
  }
}

program
  .name('provenlens')
  .description('Personal code knowledge graph for Java, Ruby, TypeScript and JavaScript')
  .version('0.1.0');

program
  .command('init')
  .argument('[path]', 'project directory', '.')
  .description('create the index in a project and build it')
  .action(async (path) => {
    const root = resolve(path);
    if (!existsSync(root)) die(`no such directory: ${root}`);
    const dbPath = dbPathFor(root);
    const fresh = !existsSync(dbPath);
    const db = openDb(dbPath, { create: true });
    console.log(`${fresh ? 'created' : 'reusing'} ${INDEX_DIR}/ in ${root}`);
    await withIndexLock(root, async () =>
      reportIndex(await indexProject(db, root, { full: true })),
    );
  });

program
  .command('index')
  .argument('[path]', 'project directory')
  .description('rebuild the whole index from scratch')
  .action(async (path) => {
    const { root, db } = useProject(path, { needsData: false });
    await withIndexLock(root, async () =>
      reportIndex(await indexProject(db, root, { full: true })),
    );
  });

program
  .command('sync')
  .argument('[path]', 'project directory')
  .option('-w, --watch', 'keep running and reindex as files change')
  .description('reindex only files whose contents changed')
  .action(async (path, opts) => {
    const { root, db } = useProject(path, { needsData: false });
    await withIndexLock(root, async () =>
      reportIndex(await indexProject(db, root, { full: false })),
    );

    if (!opts.watch) return;
    const { watchProject } = await import('../src/watch.js');
    const handle = watchProject(db, root, {
      onSync: (stats) =>
        console.log(`[${new Date().toLocaleTimeString()}] reindexed ${stats.parsed} file(s)`),
    });
    console.log(
      handle.mode === 'watch'
        ? 'watching for changes — Ctrl-C to stop'
        : `polling every 5s (no recursive watch on this platform) — Ctrl-C to stop`,
    );
    process.on('SIGINT', () => {
      handle.close();
      process.exit(0);
    });
  });

program
  .command('dead')
  .argument('[path]', 'project directory')
  .option('-n, --limit <n>', 'how many to list', '30')
  .option('--tests', 'include test files, which are normally excluded')
  .option('--public', 'also list exported and public names, which a caller outside this repo may use')
  .description('methods and functions nothing in this repository reaches')
  .action(async (path, opts) => {
    const { root, db } = useProject(path);
    const { deadCode } = await import('../src/insight.js');
    const report = deadCode(db, root, {
      limit: Number(opts.limit) || 30,
      includeTests: !!opts.tests,
      onlyCertain: !opts.public,
    });

    if (!report.candidates.length) {
      if (report.publicHeldBack) {
        console.log(
          `nothing certain. ${report.publicHeldBack} public or exported name(s) have no caller ` +
            `inside this repository, which in a library is what an API looks like — ` +
            `run with --public to read them.`,
        );
      } else {
        console.log('nothing unreached — every method and function has a caller, a binding or an entry-point marker');
      }
      return;
    }
    console.log(`${report.total} unreached, showing ${report.candidates.length}:\n`);
    for (const c of report.candidates) {
      console.log(`${c.confidence === 'high' ? '  ' : '? '}${c.file_path}:${c.start_line}  ${c.fqn}`);
    }
    // The list is exactly as good as the graph behind it, so say how good that is.
    const pct = report.refs ? ((report.unresolved / report.refs) * 100).toFixed(1) : '0.0';
    console.log(
      `\nRead these, do not delete them. ${report.unresolved} call site(s) in this repository ` +
        `(${pct}%) went unresolved, and an unresolved call looks exactly like no call at all. ` +
        `Reflection, a template naming a helper, and dispatch by string do too.`,
    );
    console.log('Lines marked ? are public or exported — something outside this repository may call them.');
    if (report.publicHeldBack) {
      console.log(
        `${report.publicHeldBack} public or exported name(s) not shown — in a library those are the API. ` +
          `Use --public to see them.`,
      );
    }
    if (report.namedInTemplate) {
      console.log(
        `${report.namedInTemplate} more were left off because a template or config file names them.`,
      );
    }
  });

program
  .command('cycles')
  .argument('[path]', 'project directory')
  .option('-n, --limit <n>', 'how many to list', '20')
  .description('files that depend on each other, directly or the long way round')
  .action(async (path, opts) => {
    const { db } = useProject(path);
    const { cycles } = await import('../src/insight.js');
    const rings = cycles(db, { limit: Number(opts.limit) || 20 });
    if (!rings.length) {
      console.log('no cycles between files');
      return;
    }
    console.log(`${rings.length} cycle(s):\n`);
    for (const ring of rings) {
      console.log(`  ${ring.join('\n    -> ')}\n    -> ${ring[0]}\n`);
    }
  });

program
  .command('routes')
  .argument('[path]', 'project directory')
  .option('-m, --match <text>', 'only routes whose path or handler contains this')
  .description('HTTP routes this repository serves, and who calls them')
  .action((path, opts) => {
    const { db } = useProject(path);
    const rows = db
      .prepare(
        `SELECT b.key, b.role, b.detail, b.line, f.path AS file_path, s.fqn
           FROM bindings b
           JOIN files f ON f.id = b.file_id
           LEFT JOIN symbols s ON s.id = b.symbol_id
          WHERE b.plugin = 'http'
          ORDER BY b.key, b.role DESC`,
      )
      .all()
      .filter(
        (r) =>
          !opts.match ||
          `${r.key} ${r.fqn ?? ''} ${r.detail ?? ''}`.toLowerCase().includes(opts.match.toLowerCase()),
      );

    if (!rows.length) {
      console.log(
        opts.match
          ? `no route matches "${opts.match}"`
          : 'no HTTP routes found — Spring, NestJS, Express and Rails routing are recognised',
      );
      return;
    }

    // A handler is also registered under `ANY <path>` so a caller whose verb
    // could not be read still reaches it. That duplicate exists to be joined
    // against, not to be read: listing it would show every route twice.
    const realVerbs = new Set(
      rows.filter((r) => !r.key.startsWith('ANY ')).map((r) => r.key.slice(r.key.indexOf(' ') + 1)),
    );
    const byKey = new Map();
    for (const r of rows) {
      if (r.role === 'provider' && r.key.startsWith('ANY ') && realVerbs.has(r.key.slice(4))) {
        continue;
      }
      if (!byKey.has(r.key)) byKey.set(r.key, { providers: [], consumers: [] });
      byKey.get(r.key)[r.role === 'provider' ? 'providers' : 'consumers'].push(r);
    }

    for (const [key, group] of byKey) {
      console.log(`\n${key}`);
      for (const p of group.providers) {
        console.log(`  served by  ${p.fqn ?? p.detail}`);
        console.log(`             ${p.file_path}:${p.line}`);
      }
      if (!group.providers.length) console.log('  served by  (nothing in this repository)');
      for (const c of group.consumers) {
        console.log(`  called by  ${c.fqn ?? c.detail}`);
        console.log(`             ${c.file_path}:${c.line}`);
      }
    }
    console.log(`\n${byKey.size} route(s).`);
  });

program
  .command('hotspots')
  .argument('[path]', 'project directory')
  .option('-n, --limit <n>', 'how many to list', '20')
  .description('what the most other code depends on — read before changing it')
  .action(async (path, opts) => {
    const { db } = useProject(path);
    const { hotspots } = await import('../src/insight.js');
    const rows = hotspots(db, { limit: Number(opts.limit) || 20 });
    if (!rows.length) {
      console.log('no symbol has a caller yet — run `provenlens index` first');
      return;
    }
    console.log(`${'callers'.padStart(8)}  ${'files'.padStart(6)}  symbol`);
    for (const r of rows) {
      console.log(
        `${String(r.callers).padStart(8)}  ${String(r.caller_files).padStart(6)}  ${r.fqn}` +
          `\n${' '.repeat(18)}${r.file_path}:${r.start_line}`,
      );
    }
  });

program
  .command('doctor')
  .argument('[path]', 'project directory')
  .description('why this repository resolves as it does, and what would change it')
  .action(async (path) => {
    const { root, db } = useProject(path);
    const { diagnose } = await import('../src/doctor.js');
    const { langs, findings, misses } = diagnose(db, root);

    const s = projectStats(db);
    const external = db.prepare('SELECT COUNT(*) AS n FROM unresolved WHERE external = 1').get().n;
    const linked = s.refs - s.unresolved;
    const inRepo = s.refs - external;
    console.log(`root:    ${root}`);
    console.log(
      `stack:   ${[...langs].map(([l, n]) => `${l} ${n}`).join(', ') || 'nothing indexed'}`,
    );
    console.log(
      `reading: ${inRepo ? ((linked / inRepo) * 100).toFixed(1) : '0.0'}% of the calls that could be in this repo`,
    );

    const blocking = findings.filter((f) => f.level === 'blocking');
    const rest = findings.filter((f) => f.level !== 'blocking');

    if (!blocking.length) {
      console.log('\nNothing is missing that this machine could supply.');
    }
    for (const group of [blocking, rest]) {
      for (const f of group) {
        const tag = f.level === 'blocking' ? 'MISSING' : f.level === 'inherent' ? 'INHERENT' : 'minor';
        console.log(`\n[${tag}] ${f.what}`);
        console.log(`  why: ${f.why}`);
        console.log(`  fix: ${f.fix}`);
      }
    }

    if (misses.total) {
      console.log(`\nWhat the ${misses.total} remaining miss(es) are:`);
      for (const r of misses.rows) console.log(`  ${String(r.n).padStart(7)}  ${r.reason}`);
    }
    console.log('\nRe-run after any fix above — the number is measured, never predicted.');
  });

program
  .command('status')
  .argument('[path]', 'project directory')
  .description('show index size, language coverage and resolution quality')
  .action((path) => {
    const scope = useScope(path);
    scope.forEach((project, i) => {
      if (i) console.log('');
      if (scope.length > 1) console.log(`# repository: ${project.name}`);
      printStatus(project.root, project.db);
    });
  });

function printStatus(root, db) {
    const s = projectStats(db);
    const last = getMeta(db, 'last_indexed_at');
    console.log(`root:    ${root}`);
    console.log(`indexed: ${last ? new Date(Number(last)).toISOString() : 'never'}`);
    console.log(`files:   ${s.files}   symbols: ${s.symbols}   types: ${s.types}`);
    const external = db.prepare('SELECT COUNT(*) AS n FROM unresolved WHERE external = 1').get().n;
    const linked = s.refs - s.unresolved;
    const inRepo = s.refs - external;
    const pct = inRepo ? ((linked / inRepo) * 100).toFixed(1) : '0.0';
    console.log(`edges:   ${s.edges}   call sites: ${s.refs}`);
    console.log(
      `calls:   ${linked} linked, ${external} into libraries, ${s.unresolved - external} missed`,
    );
    console.log(`resolution: ${pct}% of the calls that could be in this repo`);

    const bindings = db
      .prepare('SELECT plugin, role, COUNT(*) AS n FROM bindings GROUP BY plugin, role')
      .all();
    if (bindings.length) {
      const byPlugin = {};
      for (const b of bindings) (byPlugin[b.plugin] ??= {})[b.role] = b.n;
      console.log('framework bindings:');
      for (const [plugin, roles] of Object.entries(byPlugin)) {
        console.log(
          `  ${plugin.padEnd(10)} ${roles.provider ?? 0} provider(s), ${roles.consumer ?? 0} consumer(s)`,
        );
      }
    }

    // Declarations read from dependencies: not this project's code, but what
    // lets a chain be typed through a library instead of stopping at one.
    const ambient = db
      .prepare(
        `SELECT COUNT(DISTINCT owner) AS packages, COUNT(*) AS files,
                SUM(CASE WHEN path LIKE 'jvm:%' THEN 1 ELSE 0 END) AS jvm
           FROM files WHERE external = 1`,
      )
      .get();
    if (ambient?.files) {
      const dts = ambient.files - (ambient.jvm ?? 0);
      const parts = [];
      if (dts > 0) parts.push(`${dts} declaration file(s)`);
      if (ambient.jvm > 0) parts.push(`${ambient.jvm} jvm type(s)`);
      console.log(`dependencies read: ${ambient.packages} package(s); ${parts.join(', ')}`);
    }
    console.log('by language:');
    for (const l of s.byLang) {
      // xml and sql have no grammar but are read by the binding plugins, so
      // they are covered, just not parsed.
      const note = IMPLEMENTED_LANGUAGES.includes(l.lang)
        ? ''
        : ['xml', 'sql'].includes(l.lang)
          ? '  (read by framework bindings)'
          : '  (no extractor yet)';
      console.log(`  ${l.lang.padEnd(12)} ${String(l.n).padStart(5)}${note}`);
    }
}

program
  .command('query')
  .argument('<search...>', 'symbol name or fragment')
  .option('-l, --limit <n>', 'max results', '20')
  .option('--json', 'machine-readable output')
  .description('find symbols by name')
  .action((search, opts) => {
    const scope = useScope();
    const results = scope.flatMap((p) =>
      searchSymbols(p.db, search.join(' '), { limit: Number(opts.limit) }).map((r) => ({ ...r, repoName: p.name })),
    ).slice(0, Number(opts.limit));
    if (opts.json) {
      return emitJson(results.map((r) => ({ ...publicSymbol(r), ...(scope.length > 1 ? { repo: r.repoName } : {}) })));
    }
    if (!results.length) return console.log('no matches');
    for (const r of results) {
      if (scope.length > 1) process.stdout.write(`${r.repoName} · `);
      console.log(
        `${String(r.id).padStart(5)}  ${r.kind.padEnd(11)} ${r.fqn ?? r.name}\n` +
          `       ${r.file_path}:${r.start_line}  ${r.signature ?? ''}`,
      );
    }
  });

program
  .command('explore')
  .argument('<query...>', 'symbol name or question')
  .option('-m, --max-matches <n>', 'how many matches to expand', '3')
  .description('source + call paths for an area, in one shot')
  .action((query, opts) => {
    const scope = useScope();
    const q = query.join(' ');
    const sections = scope
      .filter((p) => scope.length === 1 || searchSymbols(p.db, q, { limit: 1 }).length)
      .map((p) => {
        const body = formatExplore(p.db, p.root, q, { maxMatches: Number(opts.maxMatches) });
        return scope.length > 1 ? `# repository: ${p.name}\n\n${body}` : body;
      });
    console.log(sections.length ? sections.join('\n\n---\n\n') : `no symbol matches "${q}".`);
  });

program
  .command('node')
  .argument('<name>', 'symbol name')
  .description('one symbol in full, with its caller/callee trail')
  .action((name) => {
    const scope = useScope();
    const { project, hit } = pickAcross(scope, name);
    if (scope.length > 1) console.log(`# repository: ${project.name}\n`);
    console.log(formatNode(project.db, project.root, hit.id));
  });

program
  .command('callers')
  .argument('<name>', 'symbol name')
  .option('--json', 'machine-readable output')
  .description('what calls this symbol')
  .action((name, opts) => {
    const { project, hit } = pickAcross(useScope(), name);
    if (opts.json) return emitJson(callersOf(project.db, hit.id).map(publicSymbol));
    console.log(formatRelations(project.db, hit.id, 'callers'));
  });

program
  .command('callees')
  .argument('<name>', 'symbol name')
  .option('--json', 'machine-readable output')
  .description('what this symbol calls')
  .action((name, opts) => {
    const { project, hit } = pickAcross(useScope(), name);
    if (opts.json) return emitJson(calleesOf(project.db, hit.id).map(publicSymbol));
    console.log(formatRelations(project.db, hit.id, 'callees'));
  });

program
  .command('why')
  .argument('<name>', 'symbol name')
  .option('--json', 'machine-readable output')
  .description('how much of what the graph says about this rests on a declaration')
  .action((name, opts) => {
    const { project, hit } = pickAcross(useScope(), name);
    const explained = explainSymbol(project.db, hit.id);
    if (opts.json) return emitJson(explained);
    console.log(formatWhy(explained));
  });

program
  .command('impact')
  .argument('<name>', 'symbol name')
  .option('--json', 'machine-readable output')
  .description('blast radius: everything that transitively reaches this symbol')
  .action((name, opts) => {
    const { project, hit } = pickAcross(useScope(), name);
    if (opts.json) {
      const { levels, totalSymbols, totalFiles } = impactOf(project.db, hit.id);
      return emitJson({
        symbol: publicSymbol(hit),
        totalSymbols,
        totalFiles,
        levels: levels.map((level) => (level ?? []).map(publicSymbol)),
      });
    }
    console.log(formatImpact(project.db, hit.id));
  });

program
  .command('affected')
  .argument('[files...]', 'changed files; reads stdin when omitted')
  .option('-d, --depth <n>', 'how far to follow callers', '4')
  .option('--json', 'machine-readable output')
  .option(
    '--fail-if-untested',
    'exit 2 when the change touches production code that no existing test reaches',
  )
  .description('what a set of changed files reaches, and which tests cover it')
  .action(async (files, opts) => {
    const { root, db } = useProject();
    let paths = files;
    if (!paths.length) {
      // Built for `git diff --name-only | provenlens affected`.
      paths = (await readStdin())
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    }
    if (!paths.length) die('no files given. Try: git diff --name-only | provenlens affected');

    // Accept absolute or cwd-relative paths and normalise to repo-relative.
    // A path outside the root is passed through as written, so the report can
    // name it under "not in the index" rather than silently dropping it.
    const normalised = paths.map((p) => repoRelative(root, p) ?? p.split('\\').join('/'));
    const r = affectedBy(db, normalised, { maxDepth: Number(opts.depth) });

    // The CI question: does anything already exercise what this change can
    // break? A diff that only touches tests passes by definition.
    const production = r.changed.filter((s) => !isTestPath(s.file_path));
    const untested = opts.failIfUntested && production.length > 0 && r.tests.length === 0;

    if (opts.json) {
      emitJson({
        changed: r.changed.map(publicSymbol),
        reached: r.reached.map(publicSymbol),
        tests: r.tests.map(publicSymbol),
        missingFiles: r.missingFiles,
        ...(opts.failIfUntested ? { untested } : {}),
      });
    } else {
      console.log(formatAffected(db, normalised, { maxDepth: Number(opts.depth) }));
    }

    if (untested) {
      process.stderr.write(
        `affected: ${production.length} changed production symbol(s) and no test reaches any of them.\n`,
      );
      process.exit(2);
    }
  });

program
  .command('path')
  .argument('<from>', 'starting symbol')
  .argument('<to>', 'symbol to reach')
  .option('-d, --depth <n>', 'longest chain to consider', '12')
  .option('--json', 'machine-readable output')
  .description('shortest directed chain from one symbol to another, hop by hop')
  .action((from, to, opts) => {
    const scope = useScope();
    const a = pickAcross(scope, from);
    const b = pickAcross(scope, to);
    const best = pathAcross(a, b);

    const hops = (leg) =>
      leg.hops.map((h) => ({ ...publicSymbol(h.symbol), edge: h.kind, via: h.via, confidence: h.confidence }));

    if (opts.json) {
      if (!best) return emitJson({ found: false });
      if (best.same) return emitJson({ found: true, length: best.found.length, hops: hops(best.found) });
      return emitJson({
        found: true,
        length: best.total,
        crossRepo: { plugin: best.mine.plugin, key: best.mine.key, from: a.project.name, to: b.project.name },
        hops: [...hops(best.first), ...hops(best.second)],
      });
    }

    if (!best) {
      console.log(formatPath(a.project.db, a.hit.id, b.hit.id, null));
      process.exitCode = 1;
      return;
    }
    if (best.same) {
      console.log(formatPath(a.project.db, a.hit.id, b.hit.id, best.found));
      return;
    }
    // One continuous listing: leg A, the binding that bridges the repos, leg B.
    const head = symbolLabel(a.project.db, a.hit.id);
    const goal = symbolLabel(b.project.db, b.hit.id);
    const lines = [`# Path: ${head.label} → ${goal.label}  (${a.project.name} → ${b.project.name})`, ''];
    lines.push(...pathLines(a.project.db, a.hit.id, best.first));
    lines.push(`  ══╡ ${best.mine.plugin}: ${best.mine.key} ╞══  crosses into ${b.project.name}`);
    lines.push(...pathLines(b.project.db, best.theirs.symbol_id, best.second));
    lines.push('', `${best.total} hop(s) across two repositories.`);
    console.log(lines.join('\n'));
  });

program
  .command('export')
  .argument('[name]', 'symbol to centre on; the busiest hubs when omitted')
  .option('-f, --format <fmt>', 'json | mermaid', 'json')
  .option('-d, --depth <n>', 'how far out from the seed', '2')
  .option('-m, --max <n>', 'node cap', '160')
  .description('write the graph around a symbol as JSON or a Mermaid diagram')
  .action((name, opts) => {
    const { db } = useProject();
    const depth = Math.min(Math.max(Number(opts.depth) || 2, 1), 4);
    const maxNodes = Math.min(Math.max(Number(opts.max) || 160, 1), 400);

    const seeds = name
      ? [pickSymbol(db, name).id]
      : topHubs(db, { limit: 12 }).map((h) => h.id);
    const graph = graphAround(db, seeds, { depth, maxNodes });

    if (opts.format === 'mermaid') {
      console.log('```mermaid\n' + toMermaid(graph) + '\n```');
    } else if (opts.format === 'json') {
      emitJson(graph);
    } else {
      die(`unknown format "${opts.format}" — use json or mermaid.`);
    }
  });

program
  .command('uninit')
  .argument('[path]', 'project directory')
  .description('remove the index from a project')
  .action((path) => {
    const root = findProjectRoot(path ? resolve(path) : process.cwd());
    if (!root) die(`no ${INDEX_DIR}/ found here or in any parent.`);
    rmSync(join(root, INDEX_DIR), { recursive: true, force: true });
    console.log(`removed ${join(root, INDEX_DIR)}`);
  });

program
  .command('install')
  .argument('[target]', 'claude-user | claude-project | cursor')
  .option('-n, --dry-run', 'show what would change without writing')
  .description('register the MCP server with an agent')
  .action(async (target, opts) => {
    const { TARGETS, planInstall, applyInstall, detectTargets, serverEntry } = await import(
      '../src/install.js'
    );

    const targets = target ? [target] : detectTargets();
    if (!targets.length) {
      console.log('No agent config found. Add this to your agent\'s MCP config manually:\n');
      console.log(JSON.stringify({ mcpServers: { provenlens: serverEntry() } }, null, 2));
      return;
    }

    for (const name of targets) {
      if (!TARGETS[name]) die(`unknown target "${name}". Known: ${Object.keys(TARGETS).join(', ')}`);
      try {
        const plan = opts.dryRun ? planInstall(name) : applyInstall(name);
        const verb = opts.dryRun ? `would ${plan.action}` : `${plan.action}d`;
        console.log(
          plan.action === 'unchanged'
            ? `${plan.label}: already registered (${plan.file})`
            : `${plan.label}: ${verb} ${plan.file}`,
        );
      } catch (err) {
        console.error(`${name}: ${err.message}`);
      }
    }
    if (!opts.dryRun) console.log('\nRestart the agent to pick up the new server.');
  });

program
  .command('serve')
  .argument('[paths...]', 'project directories, or one folder holding several')
  .option('-p, --port <n>', 'port to listen on', '7777')
  .option('-o, --open', 'open a browser once it is up')
  .option('--new-token', 'retire the stored UI token and mint a fresh one')
  .description('browse and search the graph in a local web UI, across one or more repos')
  .action(async (paths, opts) => {
    const { startServer } = await import('../src/server.js');
    try {
      // A folder of service checkouts is scanned one level down, so pointing
      // at a workspace opens every repository in it.
      await startServer(paths.length ? paths.map((p) => resolve(p)) : [process.cwd()], {
        port: Number(opts.port),
        open: Boolean(opts.open),
        newToken: Boolean(opts.newToken),
      });
    } catch (err) {
      die(err.message);
    }
  });

program
  .command('mcp')
  .argument('[path]', 'project directory')
  .description('run the MCP server over stdio')
  .action(async (path) => {
    const { startMcpServer } = await import('../src/mcp.js');
    await startMcpServer(path);
  });

program.parseAsync(process.argv);
