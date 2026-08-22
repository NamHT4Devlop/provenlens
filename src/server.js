/**
 * Local web UI.
 *
 * A read-only view of the index: search, then walk the graph by clicking. Bound
 * to the loopback interface and serving nothing but the page and its JSON, so
 * it exposes no more than the CLI already does.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openProject } from './db.js';
import { findProjectRoot, dbPathFor } from './project.js';
import { indexProject } from './indexer.js';
import { watchProject } from './watch.js';
import {
  searchSymbols,
  getSymbol,
  symbolSource,
  callersOf,
  calleesOf,
  impactOf,
  projectStats,
  isTestPath,
} from './query.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const CALL_KINDS = ['calls', 'instantiates'];

function relation(row) {
  return {
    id: row.id,
    name: row.name,
    fqn: row.fqn ?? row.name,
    kind: row.kind,
    file: row.file_path,
    line: row.start_line,
    lines: row.lines ?? [],
    edge: row.edge_kind,
    via: row.via,
    confidence: row.confidence,
    isTest: isTestPath(row.file_path),
  };
}

/** Everything the detail pane shows for one symbol. */
function symbolDetail(db, root, id) {
  const symbol = getSymbol(db, id);
  if (!symbol) return null;

  const callers = callersOf(db, id);
  const callees = calleesOf(db, id);
  const blast = impactOf(db, id);

  const members =
    ['class', 'interface', 'module', 'enum', 'record'].includes(symbol.kind) && symbol.fqn
      ? db
          .prepare(
            `SELECT s.id, s.name, s.kind, s.signature, s.start_line, s.modifiers
               FROM symbols s WHERE s.container_fqn = ? ORDER BY s.start_line`,
          )
          .all(symbol.fqn)
          .map((m) => ({
            id: m.id,
            name: m.name,
            kind: m.kind,
            signature: m.signature,
            line: m.start_line,
            derived: (m.modifiers ?? '').includes('generated'),
          }))
      : [];

  return {
    id: symbol.id,
    name: symbol.name,
    fqn: symbol.fqn ?? symbol.name,
    kind: symbol.kind,
    file: symbol.file_path,
    lang: symbol.lang,
    startLine: symbol.start_line,
    endLine: symbol.end_line,
    signature: symbol.signature,
    annotations: JSON.parse(symbol.annotations || '[]'),
    derived: (symbol.modifiers ?? '').includes('generated'),
    source: symbolSource(root, symbol, { maxLines: 400 }),
    members,
    callers: callers.filter((c) => CALL_KINDS.includes(c.edge_kind)).map(relation),
    callees: callees.filter((c) => CALL_KINDS.includes(c.edge_kind)).map(relation),
    wired: [
      ...callees.filter((c) => c.via?.startsWith('binding:')).map((c) => ({ ...relation(c), dir: 'out' })),
      ...callers.filter((c) => c.via?.startsWith('binding:')).map((c) => ({ ...relation(c), dir: 'in' })),
    ],
    related: callers
      .concat(callees)
      .filter((c) => ['extends', 'implements', 'includes'].includes(c.edge_kind))
      .map(relation),
    blast: { symbols: blast.totalSymbols, files: blast.totalFiles },
  };
}

function overview(db, root) {
  const s = projectStats(db);
  const external = db.prepare('SELECT COUNT(*) AS n FROM unresolved WHERE external = 1').get().n;
  const linked = s.refs - s.unresolved;
  const inRepo = s.refs - external;
  return {
    root,
    files: s.files,
    symbols: s.symbols,
    edges: s.edges,
    calls: s.refs,
    linked,
    library: external,
    missed: s.unresolved - external,
    resolution: inRepo ? Number(((linked / inRepo) * 100).toFixed(1)) : 0,
    byLang: s.byLang,
    bindings: db
      .prepare('SELECT plugin, COUNT(*) AS n FROM bindings GROUP BY plugin ORDER BY n DESC')
      .all(),
  };
}

export async function startServer(pathArg, { port = 7777, open: openBrowser = false } = {}) {
  const root = findProjectRoot(pathArg ?? process.cwd());
  if (!root) throw new Error('no .codelens/ index here or in any parent. Run `codelens init` first.');

  const { db } = openProject(dbPathFor(root));
  await indexProject(db, root, { full: false });
  const watcher = watchProject(db, root, {
    onSync: (stats) => process.stdout.write(`reindexed ${stats.parsed} file(s)\n`),
  });

  const page = readFileSync(join(HERE, 'ui', 'app.html'), 'utf8');

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    try {
      if (url.pathname === '/') return send(200, page, 'text/html; charset=utf-8');

      if (url.pathname === '/api/overview') return send(200, overview(db, root));

      if (url.pathname === '/api/search') {
        const q = url.searchParams.get('q') ?? '';
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 40), 200);
        return send(
          200,
          searchSymbols(db, q, { limit }).map((r) => ({
            id: r.id,
            name: r.name,
            fqn: r.fqn ?? r.name,
            kind: r.kind,
            file: r.file_path,
            line: r.start_line,
            lang: r.lang,
            signature: r.signature,
            score: r.score,
            derived: (r.modifiers ?? '').includes('generated'),
            isTest: isTestPath(r.file_path),
          })),
        );
      }

      if (url.pathname === '/api/symbol') {
        const detail = symbolDetail(db, root, Number(url.searchParams.get('id')));
        return detail ? send(200, detail) : send(404, { error: 'no such symbol' });
      }

      if (url.pathname === '/api/impact') {
        const id = Number(url.searchParams.get('id'));
        const { levels, totalSymbols, totalFiles } = impactOf(db, id);
        return send(200, {
          totalSymbols,
          totalFiles,
          levels: levels.map((level) => (level ?? []).map(relation)),
        });
      }

      send(404, { error: 'not found' });
    } catch (err) {
      send(500, { error: err.message });
    }
  });

  await new Promise((done, fail) => {
    server.once('error', fail);
    // Loopback only: this is a personal tool, not something to expose.
    server.listen(port, '127.0.0.1', done);
  });

  const address = `http://127.0.0.1:${port}`;
  console.log(`codelens UI on ${address}  (project: ${root})`);
  console.log('Ctrl-C to stop');

  if (openBrowser) {
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [address], { stdio: 'ignore', detached: true }).unref();
  }

  process.on('SIGINT', () => {
    watcher.close();
    server.close();
    process.exit(0);
  });

  return { server, address };
}
