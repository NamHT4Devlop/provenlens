/**
 * MCP server over stdio, hand-rolled JSON-RPC so the tool stays dependency-free.
 *
 * Only stdout carries protocol traffic -- anything diagnostic must go to stderr
 * or it corrupts the stream.
 */
import { resolve, join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { openProject } from './db.js';
import { explainSymbol } from './why.js';
import { dbPathFor, discoverProjects, repoRelative, changedPath, tryIndexLock } from './project.js';
import { indexProject } from './indexer.js';
import { watchProject } from './watch.js';
import { formatExplore, formatImpact, formatAffected, formatWhy } from './format.js';
import { searchSymbols, projectStats, bestMatch, ambiguityNote } from './query.js';

const projects = new Map(); // root -> { db, watcher }

/**
 * Every indexed repository the given path names: the repo containing it, or --
 * when it is a folder of checkouts -- each indexed repo one level down. The
 * same rule `serve` uses, so pointing any frontend at a workspace just works.
 */
async function useProjects(pathArg, defaultRoot) {
  const start = pathArg ? resolve(pathArg) : defaultRoot;
  if (!start) {
    throw new Error(
      'No project. Pass projectPath pointing at a directory that has been `provenlens init`-ed.',
    );
  }
  const roots = discoverProjects(start);
  if (!roots.length) {
    throw new Error(`No .provenlens/ index at or under ${start}. Run \`provenlens init\` there.`);
  }
  return Promise.all(roots.map(openOne));
}

async function openOne(root) {
  let entry = projects.get(root);
  if (!entry) {
    const { db } = openProject(dbPathFor(root));
    entry = { db, watcher: null };
    projects.set(root, entry);

    // One sync on first touch, then a file watcher keeps it current, so answers
    // stay fresh without rehashing the tree on every call. Under the index
    // lock: a second session opening the same repository used to race this
    // sync into a foreign-key failure, and now stands aside while it runs.
    const release = tryIndexLock(root);
    if (release) {
      try {
        await indexProject(db, root, { full: false });
      } catch (err) {
        process.stderr.write(`provenlens: initial sync failed: ${err.message}\n`);
      } finally {
        release();
      }
    } else {
      process.stderr.write('provenlens: another process is indexing this project; reading what it writes\n');
    }
    entry.watcher = watchProject(db, root, {
      onSync: (stats) => process.stderr.write(`provenlens: reindexed ${stats.parsed} file(s)\n`),
    });
  }
  return { root, db: entry.db };
}

const TOOLS = [
  {
    name: 'provenlens_explore',
    description:
      'Explore an area of the codebase in one call: returns the matching symbols\' verbatim ' +
      'line-numbered source, who calls them, what they call, and their blast radius. ' +
      'Prefer this over grep/read loops. Query with a symbol name, Type#method, or a short phrase.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name, Type#method, or a short phrase.' },
        projectPath: {
          type: 'string',
          description: 'Path inside the project to query. Required when the server has no default.',
        },
        maxMatches: { type: 'number', description: 'How many matches to expand (default 3).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'provenlens_why',
    description:
      'How much of what the graph says about a symbol rests on a declaration, and how much on a ' +
      'convention. Use this before acting on a link that matters: an edge drawn from a declaration ' +
      'and an edge drawn from a naming convention look identical in every other answer, and only ' +
      'one of them is safe to rely on. Also lists the calls the symbol makes that never resolved.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name or Type#method.' },
        projectPath: {
          type: 'string',
          description: 'Path inside the project to query. Required when the server has no default.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'provenlens_impact',
    description:
      'Blast radius for a symbol: every caller that transitively reaches it, by depth. ' +
      'Use before changing or deleting a method to see what breaks.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name or Type#method.' },
        projectPath: { type: 'string', description: 'Path inside the project to query.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'provenlens_affected',
    description:
      'Given the files a change touches, return the symbols in them, everything that ' +
      'transitively reaches those symbols, and the existing tests that already cover them. ' +
      'Use after editing, or on the output of `git diff --name-only`, to decide what to re-test.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repo-relative paths of the changed files.',
        },
        projectPath: { type: 'string', description: 'Path inside the project to query.' },
        depth: { type: 'number', description: 'How far to follow callers (default 4).' },
      },
      required: ['files'],
    },
  },
  {
    name: 'provenlens_status',
    description: 'Index coverage: files, symbols, edges and how many call sites resolved.',
    inputSchema: {
      type: 'object',
      properties: { projectPath: { type: 'string' } },
    },
  },
];

async function callTool(name, args, defaultRoot) {
  switch (name) {
    case 'provenlens_explore': {
      const all = await useProjects(args.projectPath, defaultRoot);
      // In a workspace, only the repositories that actually match speak, each
      // under its own name, so one answer covers every service at once.
      const sections = [];
      for (const { root, db } of all) {
        if (all.length > 1 && !searchSymbols(db, args.query, { limit: 1 }).length) continue;
        const body = formatExplore(db, root, args.query, { maxMatches: args.maxMatches ?? 3 });
        sections.push(all.length > 1 ? `# repository: ${basename(root)}\n\n${body}` : body);
      }
      return sections.length ? sections.join('\n\n---\n\n') : `No symbol matches "${args.query}".`;
    }
    case 'provenlens_why': {
      const all = await useProjects(args.projectPath, defaultRoot);
      for (const { db } of all) {
        const { hit, ties } = bestMatch(db, args.symbol);
        if (!hit) continue;
        // A tie is reported, not broken: an account of the wrong `save` reads
        // exactly like an account of the right one.
        if (ties.length) return ambiguityNote(args.symbol, ties);
        return formatWhy(explainSymbol(db, hit.id));
      }
      return `No symbol matches "${args.symbol}".`;
    }

    case 'provenlens_impact': {
      const all = await useProjects(args.projectPath, defaultRoot);
      for (const { root, db } of all) {
        const { hit, ties } = bestMatch(db, args.symbol);
        if (!hit) continue;
        if (ties.length) return ambiguityNote(args.symbol, ties);
        const body = formatImpact(db, hit.id);
        return all.length > 1 ? `# repository: ${basename(root)}\n\n${body}` : body;
      }
      return `No symbol matches "${args.symbol}".`;
    }
    case 'provenlens_affected': {
      const all = await useProjects(args.projectPath, defaultRoot);
      if (!(args.files ?? []).length) return 'No files given.';
      // Each file belongs to exactly one repository; group and answer per repo.
      const byRepo = new Map();
      for (const f of args.files) {
        // Three spellings arrive here. An absolute path names its repository
        // by containment, whatever separator the caller used. A repo-relative
        // one -- the form the tool describes -- names it by existing under
        // exactly one root. Anything else goes to the first repository as
        // written, so the report can say it was not in the index.
        const home =
          all.find((p) => repoRelative(p.root, f) !== null) ??
          all.find((p) => existsSync(join(p.root, f))) ??
          all[0];
        const inIndex = home.db.prepare('SELECT 1 FROM files WHERE path = ?');
        const rel = changedPath(home.root, f, { known: (q) => !!inIndex.get(q) });
        if (!byRepo.has(home.root)) byRepo.set(home.root, { db: home.db, files: [] });
        byRepo.get(home.root).files.push(rel);
      }
      const sections = [];
      for (const [root, { db, files }] of byRepo) {
        const body = formatAffected(db, files, { maxDepth: args.depth ?? 4 });
        sections.push(byRepo.size > 1 ? `# repository: ${basename(root)}\n\n${body}` : body);
      }
      return sections.join('\n\n---\n\n');
    }
    case 'provenlens_status': {
      const all = await useProjects(args.projectPath, defaultRoot);
      if (all.length > 1) {
        return (await Promise.all(all.map((p) => callTool('provenlens_status', { ...args, projectPath: p.root }, defaultRoot)))).join('\n\n');
      }
      const { root, db } = all[0];
      const s = projectStats(db);
      const external = db.prepare('SELECT COUNT(*) AS n FROM unresolved WHERE external = 1').get().n;
      const linked = s.refs - s.unresolved;
      const inRepo = s.refs - external;
      const pct = inRepo ? ((linked / inRepo) * 100).toFixed(1) : '0.0';
      const bindings = db
        .prepare('SELECT plugin, COUNT(*) AS n FROM bindings GROUP BY plugin')
        .all();

      const lines = [
        `root: ${root}`,
        `files: ${s.files}, symbols: ${s.symbols}, types: ${s.types}, edges: ${s.edges}`,
        `calls: ${s.refs} = ${linked} linked + ${external} into libraries + ` +
          `${s.unresolved - external} unresolved`,
        `resolution: ${pct}% of the calls that could target this repo ` +
          `(library calls are excluded: they cannot be linked)`,
        `by language: ${s.byLang.map((l) => `${l.lang}=${l.n}`).join(', ')}`,
      ];
      if (bindings.length) {
        lines.push(
          `framework bindings: ${bindings.map((b) => `${b.plugin}=${b.n}`).join(', ')}`,
        );
      }
      return lines.join('\n');
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function startMcpServer(pathArg) {
  // The default scope may be one repository or a workspace folder holding
  // several; discovery settles which at call time, not here.
  const start = pathArg ? resolve(pathArg) : process.cwd();
  const defaultRoot = discoverProjects(start).length ? start : null;

  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

  let buffer = '';
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      const { id, method, params } = msg;
      try {
        switch (method) {
          case 'initialize':
            reply(id, {
              protocolVersion: params?.protocolVersion ?? '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'provenlens', version: '0.1.0' },
            });
            break;
          case 'notifications/initialized':
            break;
          case 'tools/list':
            reply(id, { tools: TOOLS });
            break;
          case 'tools/call': {
            const text = await callTool(params.name, params.arguments ?? {}, defaultRoot);
            reply(id, { content: [{ type: 'text', text }] });
            break;
          }
          case 'ping':
            reply(id, {});
            break;
          default:
            if (id !== undefined) fail(id, `Unknown method: ${method}`);
        }
      } catch (err) {
        if (id !== undefined) fail(id, err.message);
      }
    }
  });

  process.stderr.write(
    `provenlens MCP ready${defaultRoot ? ` (default project: ${defaultRoot})` : ' (pass projectPath)'}\n`,
  );

  await new Promise(() => {}); // run until the client closes stdin
}
