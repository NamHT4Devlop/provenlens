/**
 * Why the graph says what it says, for one symbol.
 *
 * Every other command answers *what* is connected. This one answers *how well
 * it is known*, which is the question a reader cannot ask of any other tool
 * here: an edge drawn from a declaration and an edge drawn from a naming
 * convention look identical once they are in the graph, and only one of them
 * survives the floor.
 *
 * The classification is the same one `bench` uses for the headline numbers, so
 * a symbol's account here can never disagree with the repository's.
 */
import { getSymbol, callersOf, calleesOf } from './query.js';

/**
 * Links that rest on a convention rather than a declaration. The floor strikes
 * these off, and so does the verdict below.
 *
 * Kept in step with `scripts/bench.js`; a test fails if the two drift apart.
 */
export const GUESSED_VIA = ['name-convention', 'unique-name', 'method-missing'];

/** Runtime owners that are an assumption rather than a named dependency. */
const ASSUMED_OWNERS = new Set(['js-runtime', 'jdk-runtime', 'Kernel']);

/** How an edge came to exist, in the reader's terms rather than the resolver's. */
function evidenceOf(via) {
  if (!via || via === 'direct' || via === 'constructor') {
    return { tier: 'proof', label: 'a declaration in this repository' };
  }
  if (GUESSED_VIA.includes(via)) {
    return { tier: 'guess', label: `a convention, not a declaration (${via})` };
  }
  if (via.startsWith('binding:')) {
    return { tier: 'binding', label: `a string both sides share (${via.slice('binding:'.length)})` };
  }
  return { tier: 'inferred', label: `an inference the index can show its work for (${via})` };
}

/** The four buckets an unresolved call falls into, strongest evidence first. */
function outcomeOf(row) {
  if (row.external) {
    if (row.owner && ASSUMED_OWNERS.has(row.owner)) {
      return { tier: 'assumed', label: `assumed to be the runtime (${row.owner})` };
    }
    if (row.reason === 'external:not-in-project') {
      return { tier: 'proof', label: 'proven to leave: nothing here declares that name' };
    }
    if (row.reason === 'external:not-reachable-from-scope') {
      return { tier: 'proof', label: 'proven to leave: nothing in scope here declares it' };
    }
    if (row.owner) return { tier: 'proof', label: `proven to leave: it belongs to ${row.owner}` };
    return { tier: 'proof', label: 'proven to leave this repository' };
  }
  return { tier: 'miss', label: `unresolved (${row.reason ?? 'no reason recorded'})` };
}

/**
 * The evidence behind one symbol's place in the graph.
 *
 * Returns plain data so the CLI, `--json` and any later caller share one
 * answer rather than three that drift.
 */
export function explainSymbol(db, symbolId) {
  const symbol = getSymbol(db, symbolId);
  if (!symbol) return null;

  const link = (row) => ({
    fqn: row.fqn ?? row.name,
    file: row.file_path,
    line: row.call_line ?? row.start_line,
    via: row.via ?? 'direct',
    confidence: row.confidence ?? 1,
    kind: row.edge_kind,
    ...evidenceOf(row.via),
  });

  const callers = callersOf(db, symbolId).map(link);
  // An edge's line is where the call was written, which is inside THIS symbol.
  // For a callee the file shown is the callee's, so the line shown must be
  // the callee's declaration: a MyBatis statement was being placed at the
  // Java method's line inside the XML.
  const callees = calleesOf(db, symbolId).map((row) => ({ ...link(row), line: row.start_line }));

  // Calls written inside this symbol that never became an edge. They are the
  // other half of the account: a symbol with six proven callees and forty
  // unresolved ones is not well understood, and the graph alone cannot say so.
  const unresolved = db
    .prepare(
      `SELECT u.reason, u.external, u.owner, r.name, r.receiver, r.line
         FROM unresolved u
         JOIN refs r ON r.id = u.ref_id
        WHERE r.from_symbol_id = ?
        ORDER BY u.external DESC, r.line`,
    )
    .all(symbolId)
    .map((row) => ({
      name: row.name,
      receiver: row.receiver,
      line: row.line,
      reason: row.reason,
      ...outcomeOf(row),
    }));

  const tally = (rows) => {
    const out = {};
    for (const r of rows) out[r.tier] = (out[r.tier] ?? 0) + 1;
    return out;
  };

  return {
    symbol: {
      fqn: symbol.fqn ?? symbol.name,
      kind: symbol.kind,
      file: symbol.file_path,
      line: symbol.start_line,
    },
    callers,
    callees,
    unresolved,
    counts: {
      callers: tally(callers),
      callees: tally(callees),
      calls: tally(unresolved),
    },
  };
}
