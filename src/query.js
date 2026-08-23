import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SYMBOL_COLS = `s.id, s.name, s.fqn, s.kind, s.container_fqn, s.type_name, s.signature,
  s.arity, s.start_line, s.end_line, s.start_byte, s.end_byte, s.annotations, s.modifiers,
  f.path AS file_path, f.lang`;

function escapeFts(q) {
  return `"${q.replace(/"/g, '""')}"`;
}

/**
 * Escapes the LIKE wildcards. Without this, searching for `total_given` also
 * matches `totalXgiven`, because `_` means "any character" -- which makes every
 * snake_case name in a Ruby or SQL codebase match things it should not.
 */
function likePattern(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function getSymbol(db, id) {
  return db
    .prepare(`SELECT ${SYMBOL_COLS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`)
    .get(id);
}

/**
 * Ranked symbol lookup: exact FQN first, then exact name, then suffix, then
 * substring, then full text. Every tier runs and the best score per symbol
 * wins, so a lower tier can never push a better match down the list.
 */
export function searchSymbols(db, query, { limit = 20, kinds = null } = {}) {
  const trimmed = (query ?? '').trim();
  if (!trimmed) return [];

  const base = `SELECT ${SYMBOL_COLS} FROM symbols s JOIN files f ON f.id = s.file_id`;
  const tiers = [];

  // Support "Type#method" and "Type.method" spellings.
  const [lhs, rhs] = trimmed.includes('#')
    ? trimmed.split('#')
    : /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(trimmed)
      ? trimmed.split('.')
      : [trimmed, null];

  if (rhs) {
    tiers.push({
      score: 100,
      sql: `${base} WHERE s.name = ? AND (s.container_fqn = ? OR s.container_fqn LIKE ? ESCAPE '\\')`,
      args: [rhs, lhs, `%.${likePattern(lhs)}`],
    });
  }

  tiers.push(
    { score: 95, sql: `${base} WHERE s.fqn = ? COLLATE NOCASE`, args: [trimmed] },
    { score: 90, sql: `${base} WHERE s.name = ? COLLATE NOCASE`, args: [trimmed] },
    {
      score: 70,
      sql: `${base} WHERE s.fqn LIKE ? ESCAPE '\\' COLLATE NOCASE`,
      args: [`%${likePattern(trimmed)}`],
    },
    {
      score: 50,
      sql: `${base} WHERE s.name LIKE ? ESCAPE '\\' COLLATE NOCASE`,
      args: [`%${likePattern(trimmed)}%`],
    },
  );

  const best = new Map(); // symbol id -> row with its highest score

  const consider = (rows, score) => {
    for (const row of rows) {
      if (kinds && !kinds.includes(row.kind)) continue;
      // A derived symbol -- a Rails association reader, an XML statement -- is
      // a real answer, but when it ties with code written on disk the written
      // code is what the user meant.
      const derived = (row.modifiers ?? '').includes('"generated"');
      const adjusted = derived ? score - 1 : score;
      const existing = best.get(row.id);
      if (!existing || adjusted > existing.score) best.set(row.id, { ...row, score: adjusted });
    }
  };

  for (const tier of tiers) {
    try {
      consider(db.prepare(tier.sql).all(...tier.args), tier.score);
    } catch {
      /* a malformed pattern yields no hits from that tier */
    }
  }

  try {
    consider(
      db
        .prepare(
          `${base} JOIN symbols_fts ON symbols_fts.rowid = s.id
           WHERE symbols_fts MATCH ? ORDER BY rank`,
        )
        .all(escapeFts(trimmed)),
      30,
    );
  } catch {
    /* a query FTS5 cannot parse simply yields no extra hits */
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || (a.fqn ?? a.name).localeCompare(b.fqn ?? b.name))
    .slice(0, limit);
}

/** Verbatim source of a symbol, with real line numbers so an agent can cite it. */
export function symbolSource(root, symbol, { maxLines = 200 } = {}) {
  let text;
  try {
    text = readFileSync(join(root, symbol.file_path), 'utf8');
  } catch {
    return null;
  }
  const body = text.slice(symbol.start_byte, symbol.end_byte);
  const lines = body.split('\n');
  const truncated = lines.length > maxLines;
  const shown = truncated ? lines.slice(0, maxLines) : lines;
  const width = String(symbol.start_line + shown.length - 1).length;

  const numbered = shown
    .map((line, i) => `${String(symbol.start_line + i).padStart(width)} | ${line}`)
    .join('\n');

  return truncated
    ? `${numbered}\n${' '.repeat(width)} | ... (${lines.length - maxLines} more lines, ends L${symbol.end_line})`
    : numbered;
}

/**
 * Collapses the edge rows for one relationship into a single entry.
 *
 * A caller that calls the same method three times produces three edges. Listing
 * it three times reads as three callers, so the lines are gathered instead and
 * the strongest edge represents the pair.
 */
function groupEdges(rows) {
  const byPair = new Map();
  for (const row of rows) {
    const key = `${row.id}|${row.edge_kind}`;
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, { ...row, lines: row.call_line == null ? [] : [row.call_line] });
      continue;
    }
    if (row.call_line != null && !existing.lines.includes(row.call_line)) {
      existing.lines.push(row.call_line);
    }
    if (row.confidence > existing.confidence) {
      Object.assign(existing, row, { lines: existing.lines });
    }
  }
  for (const entry of byPair.values()) entry.lines.sort((a, b) => a - b);
  return [...byPair.values()];
}

export function callersOf(db, symbolId) {
  return groupEdges(
    db
      .prepare(
        `SELECT ${SYMBOL_COLS}, e.confidence, e.via, e.line AS call_line, e.kind AS edge_kind
           FROM edges e
           JOIN symbols s ON s.id = e.from_symbol_id
           JOIN files f   ON f.id = s.file_id
          WHERE e.to_symbol_id = ?
          ORDER BY e.confidence DESC, s.fqn`,
      )
      .all(symbolId),
  );
}

export function calleesOf(db, symbolId) {
  return groupEdges(
    db
      .prepare(
        `SELECT ${SYMBOL_COLS}, e.confidence, e.via, e.line AS call_line, e.kind AS edge_kind
           FROM edges e
           JOIN symbols s ON s.id = e.to_symbol_id
           JOIN files f   ON f.id = s.file_id
          WHERE e.from_symbol_id = ?
          ORDER BY e.line`,
      )
      .all(symbolId),
  );
}

/** Transitive callers -- what a change to this symbol can reach. */
export function impactOf(db, symbolId, { maxDepth = 4 } = {}) {
  const levels = [];
  const seen = new Set([symbolId]);
  let frontier = [symbolId];

  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const id of frontier) {
      for (const caller of callersOf(db, id)) {
        if (seen.has(caller.id)) continue;
        seen.add(caller.id);
        next.push(caller.id);
        (levels[depth - 1] ??= []).push(caller);
      }
    }
    frontier = next;
  }

  const files = new Set();
  for (const level of levels) for (const s of level ?? []) files.add(s.file_path);

  return { levels, totalSymbols: seen.size - 1, totalFiles: files.size };
}

export function projectStats(db) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  return {
    files: one('SELECT COUNT(*) AS n FROM files').n,
    symbols: one('SELECT COUNT(*) AS n FROM symbols').n,
    types: one('SELECT COUNT(*) AS n FROM types').n,
    edges: one('SELECT COUNT(*) AS n FROM edges').n,
    refs: one('SELECT COUNT(*) AS n FROM refs').n,
    unresolved: one('SELECT COUNT(*) AS n FROM unresolved').n,
    byLang: db.prepare('SELECT lang, COUNT(*) AS n FROM files GROUP BY lang ORDER BY n DESC').all(),
  };
}

/** Heuristics for "is this a test file", shared by impact reporting. */
const TEST_PATH = /(^|\/)(tests?|specs?|__tests__)\//i;
const TEST_FILE = /(Test|Tests|IT)\.java$|_spec\.rb$|_test\.rb$|\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestPath(path) {
  return TEST_PATH.test(path) || TEST_FILE.test(path);
}

/**
 * Blast radius for a set of changed files -- the `git diff --name-only`
 * question: what does this change reach, and which tests already cover it.
 */
export function affectedBy(db, relPaths, { maxDepth = 4 } = {}) {
  const placeholders = relPaths.map(() => '?').join(', ');
  if (!relPaths.length) return { changed: [], reached: [], tests: [], missingFiles: [] };

  const known = db
    .prepare(`SELECT DISTINCT path FROM files WHERE path IN (${placeholders})`)
    .all(...relPaths)
    .map((r) => r.path);
  const missingFiles = relPaths.filter((p) => !known.includes(p));

  const changed = db
    .prepare(
      `SELECT ${SYMBOL_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.path IN (${placeholders}) AND s.kind != 'file'
        ORDER BY f.path, s.start_line`,
    )
    .all(...relPaths);

  const origin = new Set(changed.map((s) => s.id));
  const reachedById = new Map();

  for (const seed of changed) {
    for (const level of impactOf(db, seed.id, { maxDepth }).levels) {
      for (const s of level ?? []) {
        // A symbol inside a changed file is already accounted for.
        if (origin.has(s.id) || reachedById.has(s.id)) continue;
        reachedById.set(s.id, s);
      }
    }
  }

  const reached = [...reachedById.values()];
  return {
    changed,
    reached: reached.filter((s) => !isTestPath(s.file_path)),
    tests: reached.filter((s) => isTestPath(s.file_path)),
    missingFiles,
  };
}

/** Edge kinds grouped for display: how a node relates to its neighbours. */
export const EDGE_GROUPS = {
  calls: 'calls',
  instantiates: 'instantiates',
  extends: 'inherits',
  implements: 'implements',
  includes: 'includes',
  'implemented-by': 'implemented by',
  'routes-to': 'routes to',
  'sends-to': 'sends to',
  'touches-table': 'touches table',
  binds: 'binds',
  declares: 'declares',
};

function graphNode(row) {
  return {
    id: row.id,
    name: row.name,
    fqn: row.fqn ?? row.name,
    kind: row.kind,
    file: row.file_path,
    line: row.start_line,
    lang: row.lang,
    derived: (row.modifiers ?? '').includes('generated'),
    isTest: isTestPath(row.file_path),
  };
}

/**
 * The neighbourhood around a symbol, for drawing.
 *
 * Breadth-first out to `depth`, capped: a hub in a large codebase has hundreds
 * of neighbours and a picture of all of them says nothing. The cap is reported
 * so the view can say what it left out rather than quietly truncating.
 */
export function graphAround(db, seedIds, { depth = 1, maxNodes = 160 } = {}) {
  const seeds = (Array.isArray(seedIds) ? seedIds : [seedIds]).filter(Boolean);
  if (!seeds.length) return { nodes: [], edges: [], truncated: false };

  const nodes = new Map();
  const edges = new Map();
  let truncated = false;

  const neighbours = db.prepare(
    `SELECT ${SYMBOL_COLS}, e.kind AS edge_kind, e.via, e.confidence,
            e.from_symbol_id AS src, e.to_symbol_id AS dst
       FROM edges e
       JOIN symbols s ON s.id = CASE WHEN e.from_symbol_id = ? THEN e.to_symbol_id
                                     ELSE e.from_symbol_id END
       JOIN files f   ON f.id = s.file_id
      WHERE e.from_symbol_id = ? OR e.to_symbol_id = ?
      ORDER BY e.confidence DESC`,
  );

  const membersOfType = db.prepare(
    `SELECT ${SYMBOL_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE s.container_fqn = ? AND s.kind IN ('method','constructor','class_method','field')
      ORDER BY s.start_line`,
  );

  for (const id of seeds) {
    const seed = getSymbol(db, id);
    if (!seed) continue;
    nodes.set(seed.id, { ...graphNode(seed), seed: true });

    // A type on its own has almost no edges -- the calls live on its members.
    // Pulling them in is what makes the picture of a class worth looking at.
    if (['class', 'interface', 'module', 'enum', 'record'].includes(seed.kind) && seed.fqn) {
      for (const member of membersOfType.all(seed.fqn)) {
        if (nodes.size >= maxNodes) { truncated = true; break; }
        if (!nodes.has(member.id)) nodes.set(member.id, graphNode(member));
        edges.set(`${seed.id}|${member.id}|declares`, {
          from: seed.id,
          to: member.id,
          kind: 'declares',
          label: 'declares',
          via: 'declaration',
          confidence: 1,
        });
      }
    }
  }

  let frontier = [...nodes.keys()];
  for (let level = 0; level < depth && frontier.length; level++) {
    const next = [];
    for (const id of frontier) {
      for (const row of neighbours.all(id, id, id)) {
        const key = `${row.src}|${row.dst}|${row.edge_kind}`;
        if (!edges.has(key)) {
          edges.set(key, {
            from: row.src,
            to: row.dst,
            kind: row.edge_kind,
            label: EDGE_GROUPS[row.edge_kind] ?? row.edge_kind,
            via: row.via,
            confidence: row.confidence,
          });
        }
        if (nodes.has(row.id)) continue;
        if (nodes.size >= maxNodes) {
          truncated = true;
          continue;
        }
        nodes.set(row.id, graphNode(row));
        next.push(row.id);
      }
    }
    frontier = next;
  }

  // An edge whose other end was cut by the cap would draw into nothing.
  const kept = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));
  return { nodes: [...nodes.values()], edges: kept, truncated };
}

/**
 * The types most other code depends on, which is a fair first answer to
 * "what is this codebase".
 *
 * Ranked by how many edges touch them: a class nothing references is not part
 * of the shape of the system, however large it is.
 */
export function topHubs(db, { limit = 12 } = {}) {
  const ranked = (kinds) =>
    db
      .prepare(
        `SELECT ${SYMBOL_COLS},
                (SELECT COUNT(*) FROM edges e
                  WHERE e.to_symbol_id = s.id OR e.from_symbol_id = s.id) AS degree
           FROM symbols s JOIN files f ON f.id = s.file_id
          WHERE s.kind IN (${kinds.map(() => '?').join(', ')}) AND s.fqn IS NOT NULL
          ORDER BY degree DESC, s.name
          LIMIT ?`,
      )
      .all(...kinds, limit);

  const types = ranked(['class', 'interface', 'module', 'record']).filter((r) => r.degree > 0);
  if (types.length) return types;

  // A small service may have no type with edges on it -- the work is in a
  // handful of methods. Showing nothing there would be worse than showing those.
  const anything = ranked([
    'class', 'interface', 'module', 'record', 'method', 'class_method', 'function',
  ]).filter((r) => r.degree > 0);
  return anything.length ? anything : ranked(['class', 'interface', 'module', 'record']);
}

/**
 * The shortest directed chain from one symbol to another, following edges the
 * way the code runs: caller to callee, interface to implementation, producer
 * to consumer. This answers the debugging question the neighbourhood view
 * cannot -- not "what surrounds A" but "HOW does A ever reach B".
 *
 * Plain breadth-first search, so the first arrival is a shortest path. The
 * hop that reached each node is kept so the answer can say why every link
 * exists (via + confidence), not just that it does.
 */
export function pathBetween(db, fromId, toId, { maxDepth = 12, maxVisited = 50000 } = {}) {
  if (!fromId || !toId) return null;
  if (fromId === toId) return { hops: [], length: 0 };

  // Call edges run method-to-method; the type-to-member link exists only as
  // structure (container_fqn), the same way graphAround synthesizes it. So a
  // type as the start flows into its members, and a type as the goal counts
  // as reached when any of its members is.
  const membersOf = db.prepare(
    `SELECT m.id FROM symbols m
       JOIN symbols t ON t.fqn IS NOT NULL AND m.container_fqn = t.fqn
      WHERE t.id = ? AND m.kind != 'file'`,
  );

  const targets = new Set([toId]);
  for (const m of membersOf.all(toId)) targets.add(m.id);

  const step = db.prepare(
    `SELECT to_symbol_id AS next, kind, via, confidence, line
       FROM edges WHERE from_symbol_id = ?`,
  );

  const cameFrom = new Map([[fromId, null]]);
  let frontier = [fromId];

  const arrive = (edge, at) => {
    if (cameFrom.has(edge.next)) return null;
    cameFrom.set(edge.next, { prev: at, kind: edge.kind, via: edge.via, confidence: edge.confidence, line: edge.line });
    return targets.has(edge.next) ? unwind(db, cameFrom, edge.next) : false;
  };

  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = [];
    for (const at of frontier) {
      const hops = step.all(at);
      // A type declares its members; code enters a class through them.
      for (const m of membersOf.all(at)) {
        hops.push({ next: m.id, kind: 'declares', via: 'structure', confidence: 1, line: null });
      }
      for (const e of hops) {
        const done = arrive(e, at);
        if (done) return done;
        if (done === false) next.push(e.next);
        if (cameFrom.size > maxVisited) return null;
      }
    }
    frontier = next;
  }
  return null;
}

function unwind(db, cameFrom, toId) {
  const bySymbol = db.prepare(
    `SELECT ${SYMBOL_COLS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  );
  const hops = [];
  for (let at = toId; cameFrom.get(at); at = cameFrom.get(at).prev) {
    const via = cameFrom.get(at);
    hops.unshift({ symbol: bySymbol.get(at), kind: via.kind, via: via.via, confidence: via.confidence, line: via.line });
  }
  return { hops, length: hops.length };
}
