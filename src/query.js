import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SYMBOL_COLS = `s.id, s.name, s.fqn, s.kind, s.container_fqn, s.signature, s.arity,
  s.start_line, s.end_line, s.start_byte, s.end_byte, s.annotations, s.modifiers,
  f.path AS file_path, f.lang`;

function escapeFts(q) {
  return `"${q.replace(/"/g, '""')}"`;
}

export function getSymbol(db, id) {
  return db
    .prepare(`SELECT ${SYMBOL_COLS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`)
    .get(id);
}

/**
 * Ranked symbol lookup: exact name first, then FQN suffix, then full text.
 * Ranking matters more than recall here -- the caller usually wants one symbol.
 */
export function searchSymbols(db, query, { limit = 20, kinds = null } = {}) {
  const seen = new Set();
  const out = [];

  const push = (rows, score) => {
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      if (kinds && !kinds.includes(r.kind)) continue;
      seen.add(r.id);
      out.push({ ...r, score });
      if (out.length >= limit) return true;
    }
    return false;
  };

  const base = `SELECT ${SYMBOL_COLS} FROM symbols s JOIN files f ON f.id = s.file_id`;

  // Support "Type#method" and "Type.method" spellings.
  const [lhs, rhs] = query.includes('#')
    ? query.split('#')
    : /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(query)
      ? query.split('.')
      : [query, null];

  if (rhs) {
    if (
      push(
        db
          .prepare(`${base} WHERE s.name = ? AND (s.container_fqn = ? OR s.container_fqn LIKE ?)`)
          .all(rhs, lhs, `%.${lhs}`),
        100,
      )
    )
      return out;
  }

  if (push(db.prepare(`${base} WHERE s.name = ? COLLATE NOCASE`).all(query), 90)) return out;
  if (push(db.prepare(`${base} WHERE s.fqn = ? COLLATE NOCASE`).all(query), 95)) return out;
  if (push(db.prepare(`${base} WHERE s.fqn LIKE ? COLLATE NOCASE`).all(`%${query}`), 70)) return out;
  if (push(db.prepare(`${base} WHERE s.name LIKE ? COLLATE NOCASE`).all(`%${query}%`), 50))
    return out;

  try {
    push(
      db
        .prepare(
          `${base} JOIN symbols_fts ON symbols_fts.rowid = s.id
           WHERE symbols_fts MATCH ? ORDER BY rank`,
        )
        .all(escapeFts(query)),
      30,
    );
  } catch {
    /* a query FTS5 cannot parse simply yields no extra hits */
  }

  return out;
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

export function callersOf(db, symbolId) {
  return db
    .prepare(
      `SELECT ${SYMBOL_COLS}, e.confidence, e.via, e.line AS call_line, e.kind AS edge_kind
         FROM edges e
         JOIN symbols s ON s.id = e.from_symbol_id
         JOIN files f   ON f.id = s.file_id
        WHERE e.to_symbol_id = ?
        ORDER BY e.confidence DESC, s.fqn`,
    )
    .all(symbolId);
}

export function calleesOf(db, symbolId) {
  return db
    .prepare(
      `SELECT ${SYMBOL_COLS}, e.confidence, e.via, e.line AS call_line, e.kind AS edge_kind
         FROM edges e
         JOIN symbols s ON s.id = e.to_symbol_id
         JOIN files f   ON f.id = s.file_id
        WHERE e.from_symbol_id = ?
        ORDER BY e.line`,
    )
    .all(symbolId);
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
