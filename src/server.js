/**
 * Local web UI, over one or several indexed repositories.
 *
 * A microservice codebase is many checkouts, and the interesting questions --
 * who publishes to this queue, who consumes it -- cross between them. Each
 * repository keeps its own index, so a symbol is addressed as `repo:id`; the
 * two halves of a queue binding are matched across indexes at query time.
 *
 * Read-only, bound to loopback, and gated by a token printed at startup.
 */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { openProject } from './db.js';
import { discoverProjects, dbPathFor } from './project.js';
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
  graphAround,
} from './query.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CALL_KINDS = ['calls', 'instantiates'];

/**
 * Only a request that believes it is talking to loopback is served.
 *
 * Binding to 127.0.0.1 stops other machines connecting, but not DNS rebinding:
 * a page on evil.com whose DNS answers 127.0.0.1 looks same-origin to the
 * browser, so it could read this API. The browser still sends the original
 * hostname in Host, which is what gives it away.
 */
function hostAllowed(req) {
  const host = String(req.headers.host ?? '')
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Constant-time compare, so a wrong token leaks nothing by how long it took. */
function sameToken(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `2:481` -- a symbol is only unique within the repository that indexed it. */
const compose = (repoId, symbolId) => `${repoId}:${symbolId}`;
function split(composite) {
  const [repo, symbol] = String(composite ?? '').split(':');
  return { repoId: Number(repo), symbolId: Number(symbol) };
}

function publicNode(project, row, extra = {}) {
  return {
    id: compose(project.id, row.id),
    repo: project.id,
    repoName: project.name,
    name: row.name,
    fqn: row.fqn ?? row.name,
    kind: row.kind,
    file: row.file_path,
    line: row.start_line,
    lang: row.lang,
    derived: (row.modifiers ?? '').includes('generated'),
    isTest: isTestPath(row.file_path),
    ...extra,
  };
}

function relation(project, row) {
  return publicNode(project, row, {
    lines: row.lines ?? [],
    edge: row.edge_kind,
    via: row.via,
    confidence: row.confidence,
  });
}

/**
 * The other end of a framework binding, wherever it lives.
 *
 * A queue name is the whole of the contract between an SQS producer and its
 * listener, and in a microservice layout those two sit in different
 * repositories. Matching the keys across indexes is the only way that edge
 * exists at all.
 */
function crossRepoLinks(projects, project, symbolIds) {
  if (projects.length < 2 || !symbolIds.length) return { nodes: [], edges: [] };

  const placeholders = symbolIds.map(() => '?').join(', ');
  const mine = project.db
    .prepare(
      `SELECT plugin, role, key, symbol_id FROM bindings
        WHERE symbol_id IN (${placeholders})`,
    )
    .all(...symbolIds);
  if (!mine.length) return { nodes: [], edges: [] };

  const nodes = new Map();
  const edges = [];

  for (const endpoint of mine) {
    const wanted = endpoint.role === 'provider' ? 'consumer' : 'provider';
    for (const other of projects) {
      if (other.id === project.id) continue;
      const matches = other.db
        .prepare(
          `SELECT b.symbol_id, s.id, s.name, s.fqn, s.kind, s.container_fqn, s.type_name,
                  s.signature, s.arity, s.start_line, s.end_line, s.start_byte, s.end_byte,
                  s.annotations, s.modifiers, f.path AS file_path, f.lang
             FROM bindings b
             JOIN symbols s ON s.id = b.symbol_id
             JOIN files f   ON f.id = s.file_id
            WHERE b.plugin = ? AND b.key = ? AND b.role = ?`,
        )
        .all(endpoint.plugin, endpoint.key, wanted);

      for (const match of matches) {
        const node = publicNode(other, match);
        nodes.set(node.id, node);
        const producer = endpoint.role === 'provider' ? node.id : compose(project.id, endpoint.symbol_id);
        const consumer = endpoint.role === 'provider' ? compose(project.id, endpoint.symbol_id) : node.id;
        edges.push({
          from: consumer,
          to: producer,
          kind: `${endpoint.plugin}-cross-repo`,
          label: `${endpoint.plugin}: ${endpoint.key}`,
          via: `binding:${endpoint.plugin}`,
          confidence: 0.85,
          crossRepo: true,
        });
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
}

/** Everything the detail pane shows for one symbol. */
function symbolDetail(projects, project, symbolId) {
  const symbol = getSymbol(project.db, symbolId);
  if (!symbol) return null;

  const callers = callersOf(project.db, symbolId);
  const callees = calleesOf(project.db, symbolId);
  const blast = impactOf(project.db, symbolId);

  const members =
    ['class', 'interface', 'module', 'enum', 'record'].includes(symbol.kind) && symbol.fqn
      ? project.db
          .prepare(
            `SELECT s.id, s.name, s.kind, s.signature, s.start_line, s.modifiers
               FROM symbols s WHERE s.container_fqn = ? ORDER BY s.start_line`,
          )
          .all(symbol.fqn)
          .map((m) => ({
            id: compose(project.id, m.id),
            name: m.name,
            kind: m.kind,
            signature: m.signature,
            line: m.start_line,
            derived: (m.modifiers ?? '').includes('generated'),
          }))
      : [];

  const cross = crossRepoLinks(projects, project, [symbolId]);

  return {
    ...publicNode(project, symbol),
    startLine: symbol.start_line,
    endLine: symbol.end_line,
    signature: symbol.signature,
    annotations: JSON.parse(symbol.annotations || '[]'),
    source: symbolSource(project.root, symbol, { maxLines: 400 }),
    members,
    callers: callers.filter((c) => CALL_KINDS.includes(c.edge_kind)).map((c) => relation(project, c)),
    callees: callees.filter((c) => CALL_KINDS.includes(c.edge_kind)).map((c) => relation(project, c)),
    wired: [
      ...callees.filter((c) => c.via?.startsWith('binding:')).map((c) => ({ ...relation(project, c), dir: 'out' })),
      ...callers.filter((c) => c.via?.startsWith('binding:')).map((c) => ({ ...relation(project, c), dir: 'in' })),
    ],
    crossRepo: cross.nodes,
    related: callers
      .concat(callees)
      .filter((c) => ['extends', 'implements', 'includes'].includes(c.edge_kind))
      .map((c) => relation(project, c)),
    blast: { symbols: blast.totalSymbols, files: blast.totalFiles },
  };
}

function repoSummary(project) {
  const s = projectStats(project.db);
  const external = project.db
    .prepare('SELECT COUNT(*) AS n FROM unresolved WHERE external = 1')
    .get().n;
  const linked = s.refs - s.unresolved;
  const inRepo = s.refs - external;
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    files: s.files,
    symbols: s.symbols,
    edges: s.edges,
    resolution: inRepo ? Number(((linked / inRepo) * 100).toFixed(1)) : 0,
    langs: s.byLang.map((l) => l.lang),
  };
}

export async function startServer(pathArgs, { port = 7777, open: openBrowser = false } = {}) {
  const requested = (Array.isArray(pathArgs) ? pathArgs : [pathArgs]).filter(Boolean);
  const roots = [...new Set((requested.length ? requested : [process.cwd()]).flatMap(discoverProjects))];

  if (!roots.length) {
    throw new Error(
      'no indexed project found. Run `codelens init` in a repository, or point serve at a folder containing several.',
    );
  }

  const projects = [];
  for (const [id, root] of roots.entries()) {
    const { db } = openProject(dbPathFor(root));
    await indexProject(db, root, { full: false });
    const watcher = watchProject(db, root, {
      onSync: (stats) => process.stdout.write(`${basename(root)}: reindexed ${stats.parsed} file(s)\n`),
    });
    projects.push({ id, name: basename(root), root, db, watcher });
  }

  const byRepoId = new Map(projects.map((p) => [p.id, p]));
  const page = readFileSync(join(HERE, 'ui', 'app.html'), 'utf8');
  // Loopback keeps other machines out; the token keeps other processes on this
  // machine out. Printed with the URL, the way Jupyter does it.
  const token = randomBytes(16).toString('hex');

  /** Repositories a request is scoped to: one named repo, or all of them. */
  function scope(url) {
    const asked = url.searchParams.get('repo');
    if (asked === null || asked === '' || asked === 'all') return projects;
    const one = byRepoId.get(Number(asked));
    return one ? [one] : [];
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        // Nothing here should ever be framed or sniffed into something else.
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (!hostAllowed(req)) {
      return send(403, { error: 'this server answers only to localhost' });
    }

    const presented = url.searchParams.get('token') ?? req.headers['x-codelens-token'];
    if (!sameToken(presented, token)) {
      const hint = `codelens: this URL needs the token printed when the server started.`;
      return url.pathname === '/'
        ? send(403, `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px">
             <p>${hint}</p><p>Look for <code>?token=…</code> in the terminal.</p>`, 'text/html; charset=utf-8')
        : send(403, { error: hint });
    }

    try {
      if (url.pathname === '/') {
        // The page carries the token so its own fetches can present it.
        return send(200, page.replace('__CODELENS_TOKEN__', token), 'text/html; charset=utf-8');
      }

      if (url.pathname === '/api/repos') {
        return send(200, projects.map(repoSummary));
      }

      if (url.pathname === '/api/overview') {
        const repos = projects.map(repoSummary);
        return send(200, {
          repos,
          symbols: repos.reduce((n, r) => n + r.symbols, 0),
          edges: repos.reduce((n, r) => n + r.edges, 0),
          files: repos.reduce((n, r) => n + r.files, 0),
          // Weighted by how much of each repo there is to resolve.
          resolution: repos.length
            ? Number(
                (repos.reduce((n, r) => n + r.resolution * r.symbols, 0) /
                  Math.max(repos.reduce((n, r) => n + r.symbols, 0), 1)).toFixed(1),
              )
            : 0,
        });
      }

      if (url.pathname === '/api/search') {
        const q = url.searchParams.get('q') ?? '';
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 40), 200);
        const targets = scope(url);
        // Each repository is searched to the full limit, then the merged list
        // is ranked, so a small repo is not crowded out by a large one.
        const merged = targets.flatMap((p) =>
          searchSymbols(p.db, q, { limit }).map((r) => ({ ...publicNode(p, r), score: r.score })),
        );
        merged.sort((a, b) => b.score - a.score || a.fqn.localeCompare(b.fqn));
        return send(200, merged.slice(0, limit));
      }

      if (url.pathname === '/api/symbol') {
        const { repoId, symbolId } = split(url.searchParams.get('id'));
        const project = byRepoId.get(repoId);
        if (!project) return send(404, { error: 'no such repository' });
        const detail = symbolDetail(projects, project, symbolId);
        return detail ? send(200, detail) : send(404, { error: 'no such symbol' });
      }

      if (url.pathname === '/api/graph') {
        const depth = Math.min(Number(url.searchParams.get('depth') ?? 1), 3);
        const maxNodes = Math.min(Number(url.searchParams.get('max') ?? 160), 400);

        // Seeds may name several repositories at once; each is walked in its
        // own index and the pieces are stitched together by composite id.
        const wanted = new Map();
        for (const raw of (url.searchParams.get('ids') ?? '').split(',')) {
          const { repoId, symbolId } = split(raw);
          if (!byRepoId.has(repoId) || !Number.isFinite(symbolId)) continue;
          if (!wanted.has(repoId)) wanted.set(repoId, []);
          wanted.get(repoId).push(symbolId);
        }

        const nodes = [];
        const edges = [];
        let truncated = false;

        for (const [repoId, ids] of wanted) {
          const project = byRepoId.get(repoId);
          const g = graphAround(project.db, ids, { depth, maxNodes });
          truncated ||= g.truncated;
          for (const n of g.nodes) {
            nodes.push({ ...publicNode(project, { ...n, file_path: n.file, start_line: n.line }), seed: n.seed });
          }
          for (const e of g.edges) {
            edges.push({ ...e, from: compose(repoId, e.from), to: compose(repoId, e.to) });
          }
          const cross = crossRepoLinks(projects, project, g.nodes.map((n) => n.id));
          nodes.push(...cross.nodes);
          edges.push(...cross.edges);
        }

        const seen = new Set();
        return send(200, {
          nodes: nodes.filter((n) => (seen.has(n.id) ? false : seen.add(n.id))),
          edges,
          truncated,
        });
      }

      if (url.pathname === '/api/impact') {
        const { repoId, symbolId } = split(url.searchParams.get('id'));
        const project = byRepoId.get(repoId);
        if (!project) return send(404, { error: 'no such repository' });
        const { levels, totalSymbols, totalFiles } = impactOf(project.db, symbolId);
        return send(200, {
          totalSymbols,
          totalFiles,
          levels: levels.map((level) => (level ?? []).map((r) => relation(project, r))),
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

  const actual = server.address().port;
  const address = `http://127.0.0.1:${actual}/?token=${token}`;
  console.log(`codelens UI on ${address}`);
  console.log(
    projects.length === 1
      ? `project: ${projects[0].root}`
      : `${projects.length} repositories: ${projects.map((p) => p.name).join(', ')}`,
  );
  console.log('Ctrl-C to stop');

  if (openBrowser) {
    const { spawn } = await import('node:child_process');
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [address], { stdio: 'ignore', detached: true }).unref();
  }

  const close = () => {
    for (const p of projects) p.watcher.close();
    server.close();
  };
  process.on('SIGINT', () => {
    close();
    process.exit(0);
  });

  // The watchers hold the event loop open, so a programmatic caller needs a
  // way to shut everything down.
  return { server, address, token, projects, close };
}
