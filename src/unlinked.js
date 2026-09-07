/**
 * The call sites an answer used to leave out.
 *
 * The graph refuses to guess: `thing.save` with `thing` untyped and three
 * `save` methods declared is recorded as `ambiguous-name`, not drawn to one
 * of them. That is the right edge to withhold, and the wrong thing to hide.
 * `callers perform_async` on sidekiq answered "one" while 87 call sites named
 * perform_async sat unresolved, 81 of them in tests, and nothing in the answer
 * said so. On a Rails codebase a third of the in-repo calls sit there.
 *
 * This module finds those sites for a symbol -- same name, arity that fits,
 * receiver the resolver could not type -- so every answer about the symbol can
 * list them beside the edges. Beside, never among: a candidate here is a place
 * to read, not a caller, and nothing in `status`, `why` or the benchmark
 * counts it as linked.
 */
import { isTestPath } from './query.js';
import { RUNTIME_NAMES } from './insight.js';

/** Kinds a `new` ref can name; everything else is a call to a member or function. */
const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'record', 'module']);

/**
 * The languages whose call sites can reach each other's declarations. A
 * TypeScript file calls into JavaScript and back; a Ruby `run` and a
 * TypeScript `run` in the same repository are strangers.
 */
const JS_FAMILY = ['typescript', 'tsx', 'javascript'];
export function languageFamily(lang) {
  return JS_FAMILY.includes(lang) ? JS_FAMILY : [lang];
}

/**
 * Every unresolved in-repo call site with this name, in a language that
 * could reach `lang`.
 *
 * Left out on purpose: a call whose receiver WAS typed and found not to have
 * the member (`no-such-member-on:T`, `no-such-method-on:T`) -- the resolver
 * knew the target and it was not this one -- and annotations, which are not
 * calls. A call proven to leave the repository is not here either; that is
 * the `external` flag, and `why` accounts for those.
 */
export function unlinkedCallsNamed(db, name, lang) {
  const langs = languageFamily(lang);
  return db
    .prepare(
      `SELECT r.id, r.name, r.receiver, r.arity, r.kind, r.line, u.reason,
              f.path AS file_path, f.lang, s.fqn AS from_fqn, s.id AS from_id
         FROM unresolved u
         JOIN refs r         ON r.id = u.ref_id
         JOIN files f        ON f.id = r.file_id
         LEFT JOIN symbols s ON s.id = r.from_symbol_id
        WHERE u.external = 0 AND f.external = 0
          AND r.name = ? AND r.kind != 'annotation'
          AND f.lang IN (${langs.map(() => '?').join(', ')})
          AND (u.reason IS NULL OR u.reason NOT LIKE 'no-such-%')
        ORDER BY f.path, r.line`,
    )
    .all(name, ...langs)
    .map((row) => ({ ...row, is_test: isTestPath(row.file_path) }));
}

/**
 * Could this declaration take a call with that many arguments?
 *
 * Unknown counts pass. A rest parameter takes any number: Java `String...`,
 * TypeScript `...args`, Ruby `*args`. Java otherwise needs the exact count --
 * an overload is chosen by it -- while the other three default parameters
 * freely, so fewer arguments fit and more do not.
 */
export function arityFits(symbol, ref) {
  if (ref.arity == null || symbol.arity == null) return true;
  const sig = symbol.signature ?? '';
  const params = symbol.params ?? '';
  if (sig.includes('...') || params.includes('...') || /[(,]\s*\*/.test(sig)) return true;
  if (symbol.lang === 'java') return ref.arity === symbol.arity;
  return ref.arity <= symbol.arity;
}

/** The resolver's reason, in the reader's words. */
export function unlinkedReason(reason) {
  switch (reason) {
    case 'ambiguous-name':
      return 'receiver untyped, and this name is declared in more than one place';
    case 'complex-receiver-chain':
      return 'receiver is the result of another call';
    case 'unknown-type':
      return 'receiver type not found';
    case 'no-enclosing-symbol':
      return 'call outside any declared symbol';
    default:
      return reason ?? 'unresolved';
  }
}

/**
 * The unresolved call sites that could be calling this symbol: same name,
 * an argument count it accepts, a receiver nobody could type. Grouped by
 * file, production files first, so a reader can go and look.
 */
export function candidateCallersOf(db, symbol) {
  const wantsNew = TYPE_KINDS.has(symbol.kind);
  const sites = unlinkedCallsNamed(db, symbol.name, symbol.lang).filter(
    (r) => (wantsNew ? r.kind === 'new' : r.kind !== 'new') && arityFits(symbol, r),
  );

  const byFile = new Map();
  for (const r of sites) {
    if (!byFile.has(r.file_path)) {
      byFile.set(r.file_path, { file: r.file_path, is_test: r.is_test, lines: [], reasons: [] });
    }
    const entry = byFile.get(r.file_path);
    entry.lines.push(r.line);
    const reason = r.reason ?? 'unresolved';
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  }
  const files = [...byFile.values()].sort(
    (a, b) => Number(a.is_test) - Number(b.is_test) || a.file.localeCompare(b.file),
  );

  return {
    total: sites.length,
    inTests: sites.filter((r) => r.is_test).length,
    files,
    sites,
  };
}

/**
 * For a set of changed symbols, the test files that call one of their names
 * without the call ever becoming an edge. `affected` lists these after the
 * tests it can prove reach the change: on a Rails model most of the specs
 * that exercise it are here, because `post.publish` with `post` untyped is
 * exactly the call the resolver declines.
 *
 * Names a runtime calls on its own (`toString`, `to_s`, `initialize`) are
 * skipped, and so is a name the repository declares in more than a few
 * places: every test calls `id` or `name` on something, and on rubygems.org
 * those two alone put 73 test files under one model. A column attribute or
 * any other generated symbol is skipped for the same reason -- it is not a
 * thing this change wrote. `callers` on the symbol itself still lists them.
 */
const UBIQUITOUS = 3;
export function candidateTestsFor(db, changedSymbols) {
  const declaredTimes = db.prepare(
    `SELECT COUNT(*) AS n FROM symbols s JOIN files f ON f.id = s.file_id
      WHERE f.external = 0 AND s.name = ? AND s.kind != 'file'`,
  );
  const generated = (sym) => /generated|schema-column/.test(sym.modifiers ?? '');
  const byFile = new Map();
  for (const sym of changedSymbols) {
    if (sym.kind === 'file' || RUNTIME_NAMES.has(sym.name) || isTestPath(sym.file_path)) continue;
    if (generated(sym) || declaredTimes.get(sym.name).n > UBIQUITOUS) continue;
    for (const f of candidateCallersOf(db, sym).files) {
      if (!f.is_test) continue;
      if (!byFile.has(f.file)) byFile.set(f.file, { file: f.file, names: [], lines: [] });
      const entry = byFile.get(f.file);
      if (!entry.names.includes(sym.name)) entry.names.push(sym.name);
      for (const line of f.lines) if (!entry.lines.includes(line)) entry.lines.push(line);
    }
  }
  return [...byFile.values()]
    .map((e) => ({ ...e, lines: e.lines.sort((a, b) => a - b) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}
