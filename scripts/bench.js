#!/usr/bin/env -S node --no-warnings
/**
 * Index a repository and report how much of its call graph was resolved.
 *
 *   ./scripts/bench.js <repo> [--detail]
 *
 * The number that matters is IN-REPO RESOLUTION. Raw "resolved %" is dominated
 * by calls into libraries, which no amount of work on this tool can link.
 */
import { openDb } from '../src/db.js';
import { indexProject } from '../src/indexer.js';
import { projectStats } from '../src/query.js';
import { rmSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const detail = args.includes('--detail');

if (!root) {
  console.error('usage: bench.js <repo-path> [--detail]');
  process.exit(1);
}

// Kept out of the repository being measured, so nothing is written into it.
const dbPath = join(mkdtempSync(join(tmpdir(), 'codelens-bench-')), 'index.db');

const db = openDb(dbPath, { create: true });
const started = Date.now();
const stats = await indexProject(db, root, { full: true });
const elapsed = (Date.now() - started) / 1000;

const s = projectStats(db);
const external = db.prepare('SELECT COUNT(*) n FROM unresolved WHERE external = 1').get().n;
const missed = s.unresolved - external;
const linked = s.refs - s.unresolved;
const inRepo = s.refs - external;
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0');

console.log(`repo:     ${root}`);
console.log(`time:     ${elapsed.toFixed(1)}s  (${(s.files / elapsed).toFixed(0)} files/s)`);
console.log(`files:    ${s.files}   symbols: ${s.symbols}   edges: ${s.edges}`);
console.log(`calls:    ${s.refs} = ${linked} linked + ${external} library + ${missed} missed`);
console.log(`library share:      ${pct(external, s.refs)}%`);
console.log(`IN-REPO RESOLUTION: ${pct(linked, inRepo)}%`);

// The library bucket is not one thing. Naming an import is a proof; assuming
// `.map` on an untyped receiver is an Array is not. Keep them visible.
const byEvidence = db
  .prepare(
    `SELECT CASE
              WHEN owner IN ('js-runtime', 'jdk-runtime', 'Kernel') THEN 'runtime built-in (assumed)'
              WHEN reason = 'external:not-in-project' THEN 'name declared nowhere (proven)'
              WHEN owner IS NOT NULL THEN 'named library (proven)'
              ELSE 'other'
            END AS evidence,
            COUNT(*) AS n
       FROM unresolved WHERE external = 1 GROUP BY evidence ORDER BY n DESC`,
  )
  .all();
if (byEvidence.length) {
  console.log('  library bucket by evidence:');
  for (const row of byEvidence) {
    console.log(`    ${String(row.n).padStart(7)}  ${row.evidence}`);
  }
  const assumed = byEvidence.find((r) => r.evidence.includes('assumed'))?.n ?? 0;

  // Links that rest on a convention rather than a declaration. They belong in
  // the floor too: an assumption that RESOLVED a call flatters the headline
  // exactly as much as one that excused a call, and hiding it here would make
  // the self-audit a half-audit.
  const GUESSED_VIA = ['name-convention', 'unique-name', 'method-missing'];
  const guessed = db
    .prepare(
      `SELECT via, COUNT(*) n FROM edges
        WHERE via IN (${GUESSED_VIA.map(() => '?').join(', ')})
        GROUP BY via ORDER BY n DESC`,
    )
    .all(...GUESSED_VIA);
  const guessedTotal = guessed.reduce((n, r) => n + r.n, 0);
  if (guessedTotal) {
    console.log('  links resting on a convention, not a declaration:');
    for (const row of guessed) {
      console.log(`    ${String(row.n).padStart(7)}  ${row.via}`);
    }
  }

  if (assumed || guessedTotal) {
    // What the figure would be if every assumption were wrong: the excused
    // calls come back into the denominator, the guessed links leave the top.
    console.log(
      `  if every assumption were wrong: ${pct(linked - guessedTotal, inRepo + assumed)}%`,
    );
  }
}

const columns = db
  .prepare("SELECT COUNT(*) n FROM symbols WHERE modifiers LIKE '%schema-column%'")
  .get().n;
if (columns) {
  const onColumns = db
    .prepare(
      `SELECT COUNT(*) n FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
        WHERE s.modifiers LIKE '%schema-column%'`,
    )
    .get().n;
  console.log(`schema:   ${columns} column attributes, ${onColumns} edge(s) land on one`);
}

const bindings = db.prepare('SELECT COUNT(*) n FROM bindings').get().n;
if (bindings) {
  const rows = db
    .prepare(
      `SELECT plugin, role, COUNT(*) n FROM bindings GROUP BY plugin, role ORDER BY plugin, role`,
    )
    .all();
  console.log(`bindings: ${rows.map((r) => `${r.plugin}/${r.role}=${r.n}`).join('  ')}`);
  const wired = db.prepare("SELECT COUNT(*) n FROM edges WHERE via LIKE 'binding:%'").get().n;
  console.log(`          ${wired} edge(s) wired by string matching`);
}

for (const [lang, r] of Object.entries(stats.resolve ?? {})) {
  console.log(
    `  ${lang}: direct=${r.direct} viaImpl=${r.viaImpl} byName=${r.uniqueName} ` +
      `library=${r.external ?? 0} missed=${r.unresolved}${r.dropped ? ` dropped=${r.dropped}` : ''}`,
  );
}
console.log(`db: ${(statSync(dbPath).size / 1e6).toFixed(1)} MB`);

if (detail) {
  console.log('\nlibraries detected:');
  for (const row of db
    .prepare(
      `SELECT owner, COUNT(*) n FROM unresolved WHERE external = 1 AND owner IS NOT NULL
        GROUP BY owner ORDER BY n DESC LIMIT 10`,
    )
    .all()) {
    console.log(`  ${String(row.n).padStart(6)}  ${row.owner}`);
  }
  console.log('\nremaining misses:');
  for (const row of db
    .prepare(
      `SELECT u.reason, COUNT(*) n FROM unresolved u WHERE u.external = 0
        GROUP BY u.reason ORDER BY n DESC LIMIT 6`,
    )
    .all()) {
    console.log(`  ${String(row.n).padStart(6)}  ${row.reason}`);
  }
  for (const row of db
    .prepare(
      `SELECT r.receiver, r.name, COUNT(*) n FROM unresolved u JOIN refs r ON r.id = u.ref_id
        WHERE u.external = 0 GROUP BY r.receiver, r.name ORDER BY n DESC LIMIT 10`,
    )
    .all()) {
    console.log(`  ${String(row.n).padStart(6)}  ${row.receiver ?? '(bare)'}.${row.name}`);
  }
}

db.close();
rmSync(dbPath, { force: true });
