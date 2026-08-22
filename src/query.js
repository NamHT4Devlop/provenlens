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
