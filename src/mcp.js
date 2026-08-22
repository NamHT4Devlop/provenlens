/**
 * MCP server over stdio, hand-rolled JSON-RPC so the tool stays dependency-free.
 *
 * Only stdout carries protocol traffic -- anything diagnostic must go to stderr
 * or it corrupts the stream.
 */
import { resolve } from 'node:path';
import { openProject } from './db.js';
import { findProjectRoot, dbPathFor } from './project.js';
import { indexProject } from './indexer.js';
import { watchProject } from './watch.js';
import { formatExplore, formatImpact, formatAffected } from './format.js';
import { searchSymbols, projectStats } from './query.js';

const projects = new Map(); // root -> { db, watcher }

async function useProject(pathArg, defaultRoot) {
  const start = pathArg ? resolve(pathArg) : defaultRoot;
  if (!start) {
    throw new Error(
      'No project. Pass projectPath pointing at a directory that has been `codelens init`-ed.',
    );
  }
  const root = findProjectRoot(start);
  if (!root) throw new Error(`No .codelens/ index at or above ${start}. Run \`codelens init\` there.`);

  let entry = projects.get(root);
  if (!entry) {
    const { db } = openProject(dbPathFor(root));
    entry = { db, watcher: null };
    projects.set(root, entry);

    // One sync on first touch, then a file watcher keeps it current, so answers
    // stay fresh without rehashing the tree on every call.
    try {
      await indexProject(db, root, { full: false });
    } catch (err) {
      process.stderr.write(`codelens: initial sync failed: ${err.message}\n`);
    }
    entry.watcher = watchProject(db, root, {
      onSync: (stats) => process.stderr.write(`codelens: reindexed ${stats.parsed} file(s)\n`),
    });
  }
  return { root, db: entry.db };
}

const TOOLS = [
  {
    name: 'codelens_explore',
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
    name: 'codelens_impact',
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
    name: 'codelens_affected',
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
    name: 'codelens_status',
    description: 'Index coverage: files, symbols, edges and how many call sites resolved.',
    inputSchema: {
      type: 'object',
      properties: { projectPath: { type: 'string' } },
    },
  },
];

async function callTool(name, args, defaultRoot) {
  switch (name) {
    case 'codelens_explore': {
      const { root, db } = await useProject(args.projectPath, defaultRoot);
      return formatExplore(db, root, args.query, { maxMatches: args.maxMatches ?? 3 });
    }
    case 'codelens_impact': {
      const { db } = await useProject(args.projectPath, defaultRoot);
      const matches = searchSymbols(db, args.symbol, { limit: 5 });
      if (!matches.length) return `No symbol matches "${args.symbol}".`;
      return formatImpact(db, matches[0].id);
    }
    case 'codelens_affected': {
      const { root, db } = await useProject(args.projectPath, defaultRoot);
      const files = (args.files ?? []).map((f) => {
        const abs = resolve(f);
        return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : f;
      });
      if (!files.length) return 'No files given.';
      return formatAffected(db, files, { maxDepth: args.depth ?? 4 });
    }
    case 'codelens_status': {
      const { root, db } = await useProject(args.projectPath, defaultRoot);
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
  const defaultRoot = findProjectRoot(pathArg ? resolve(pathArg) : process.cwd());

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
              serverInfo: { name: 'codelens', version: '0.1.0' },
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
    `codelens MCP ready${defaultRoot ? ` (default project: ${defaultRoot})` : ' (pass projectPath)'}\n`,
  );

  await new Promise(() => {}); // run until the client closes stdin
}
