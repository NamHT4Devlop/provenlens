#!/usr/bin/env -S node --no-warnings
import { Command } from 'commander';
import { resolve, join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { openDb, openProject, getMeta } from '../src/db.js';
import { findProjectRoot, dbPathFor, INDEX_DIR } from '../src/project.js';
import { indexProject } from '../src/indexer.js';
import {
  searchSymbols,
  projectStats,
  callersOf,
  calleesOf,
  impactOf,
  affectedBy,
} from '../src/query.js';
import {
  formatExplore,
  formatNode,
  formatImpact,
  formatRelations,
  formatAffected,
} from '../src/format.js';
import { IMPLEMENTED_LANGUAGES } from '../src/extract/index.js';

const program = new Command();

/** Machine-readable output, so codelens can feed other tools. */
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
  console.error(`codelens: ${msg}`);
  process.exit(1);
}

/** Opens the nearest indexed project, or explains how to make one. */
function useProject(pathArg, { needsData = true } = {}) {
  const root = findProjectRoot(pathArg ? resolve(pathArg) : process.cwd());
  if (!root) die(`no ${INDEX_DIR}/ found here or in any parent. Run \`codelens init\` first.`);
  const { db, staleSchema } = openProject(dbPathFor(root));
  if (staleSchema && needsData) {
    die('index was built by an older version and has been reset. Run `codelens index`.');
  }
  return { root, db };
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

function reportIndex(stats) {
  console.log(
    `indexed ${stats.parsed} file(s), ${stats.symbols} symbol(s)` +
      (stats.skipped ? `, ${stats.skipped} unchanged` : '') +
      (stats.removed ? `, ${stats.removed} removed` : ''),
  );
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
  .name('codelens')
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
    reportIndex(await indexProject(db, root, { full: true }));
  });

program
  .command('index')
  .argument('[path]', 'project directory')
  .description('rebuild the whole index from scratch')
  .action(async (path) => {
    const { root, db } = useProject(path, { needsData: false });
    reportIndex(await indexProject(db, root, { full: true }));
  });

program
  .command('sync')
  .argument('[path]', 'project directory')
  .option('-w, --watch', 'keep running and reindex as files change')
  .description('reindex only files whose contents changed')
  .action(async (path, opts) => {
    const { root, db } = useProject(path, { needsData: false });
    reportIndex(await indexProject(db, root, { full: false }));

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
  .command('status')
  .argument('[path]', 'project directory')
  .description('show index size, language coverage and resolution quality')
  .action((path) => {
    const { root, db } = useProject(path);
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
  });

program
  .command('query')
  .argument('<search...>', 'symbol name or fragment')
  .option('-l, --limit <n>', 'max results', '20')
  .option('--json', 'machine-readable output')
  .description('find symbols by name')
  .action((search, opts) => {
    const { db } = useProject();
    const results = searchSymbols(db, search.join(' '), { limit: Number(opts.limit) });
    if (opts.json) return emitJson(results.map(publicSymbol));
    if (!results.length) return console.log('no matches');
    for (const r of results) {
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
    const { root, db } = useProject();
    console.log(formatExplore(db, root, query.join(' '), { maxMatches: Number(opts.maxMatches) }));
  });

program
  .command('node')
  .argument('<name>', 'symbol name')
  .description('one symbol in full, with its caller/callee trail')
  .action((name) => {
    const { root, db } = useProject();
    console.log(formatNode(db, root, pickSymbol(db, name).id));
  });

program
  .command('callers')
  .argument('<name>', 'symbol name')
  .option('--json', 'machine-readable output')
  .description('what calls this symbol')
  .action((name, opts) => {
    const { db } = useProject();
    const id = pickSymbol(db, name).id;
    if (opts.json) return emitJson(callersOf(db, id).map(publicSymbol));
    console.log(formatRelations(db, id, 'callers'));
  });

program
  .command('callees')
  .argument('<name>', 'symbol name')
  .option('--json', 'machine-readable output')
  .description('what this symbol calls')
  .action((name, opts) => {
    const { db } = useProject();
    const id = pickSymbol(db, name).id;
    if (opts.json) return emitJson(calleesOf(db, id).map(publicSymbol));
    console.log(formatRelations(db, id, 'callees'));
  });

program
  .command('impact')
  .argument('<name>', 'symbol name')
  .option('--json', 'machine-readable output')
  .description('blast radius: everything that transitively reaches this symbol')
  .action((name, opts) => {
    const { db } = useProject();
    const id = pickSymbol(db, name).id;
    if (opts.json) {
      const { levels, totalSymbols, totalFiles } = impactOf(db, id);
      return emitJson({
        symbol: publicSymbol(pickSymbol(db, name)),
        totalSymbols,
        totalFiles,
        levels: levels.map((level) => (level ?? []).map(publicSymbol)),
      });
    }
    console.log(formatImpact(db, id));
  });

program
  .command('affected')
  .argument('[files...]', 'changed files; reads stdin when omitted')
  .option('-d, --depth <n>', 'how far to follow callers', '4')
  .option('--json', 'machine-readable output')
  .description('what a set of changed files reaches, and which tests cover it')
  .action(async (files, opts) => {
    const { root, db } = useProject();
    let paths = files;
    if (!paths.length) {
      // Built for `git diff --name-only | codelens affected`.
      paths = (await readStdin())
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    }
    if (!paths.length) die('no files given. Try: git diff --name-only | codelens affected');

    // Accept absolute or cwd-relative paths and normalise to repo-relative.
    const normalised = paths.map((p) => {
      const abs = resolve(p);
      return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : p;
    });
    if (opts.json) {
      const r = affectedBy(db, normalised, { maxDepth: Number(opts.depth) });
      return emitJson({
        changed: r.changed.map(publicSymbol),
        reached: r.reached.map(publicSymbol),
        tests: r.tests.map(publicSymbol),
        missingFiles: r.missingFiles,
      });
    }
    console.log(formatAffected(db, normalised, { maxDepth: Number(opts.depth) }));
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
      console.log(JSON.stringify({ mcpServers: { codelens: serverEntry() } }, null, 2));
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
  .argument('[path]', 'project directory')
  .option('-p, --port <n>', 'port to listen on', '7777')
  .option('-o, --open', 'open a browser once it is up')
  .description('browse and search the graph in a local web UI')
  .action(async (path, opts) => {
    const { startServer } = await import('../src/server.js');
    try {
      await startServer(path ? resolve(path) : process.cwd(), {
        port: Number(opts.port),
        open: Boolean(opts.open),
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
