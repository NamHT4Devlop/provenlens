import {
  affectedBy,
  searchSymbols,
  symbolSource,
  callersOf,
  calleesOf,
  impactOf,
  getSymbol,
} from './query.js';

const loc = (s) => `${s.file_path}:${s.start_line}`;

function label(s) {
  const ann = JSON.parse(s.annotations || '[]');
  const badge = ann.length ? ` @${ann.join(' @')}` : '';
  return `${s.kind} ${s.fqn ?? s.name}${badge}`;
}

function confidenceNote(e) {
  if (e.confidence >= 1) return e.via === 'declaration' ? '' : ' [direct]';
  return ` [${e.via}, confidence ${e.confidence.toFixed(2)}]`;
}

/** `:7, 8, 9` -- one caller calling three times is still one caller. */
function lineNote(e) {
  if (!e.lines?.length) return e.start_line ? `:${e.start_line}` : '';
  return `:${e.lines.join(', ')}`;
}

/** `new Foo()` is a dependency too, so instantiation shows alongside calls. */
const CALL_KINDS = ['calls', 'instantiates'];
const kindNote = (e) => (e.edge_kind === 'instantiates' ? ' (instantiates)' : '');

/** Symbols a plugin invented (SQL statements, routes, migrations) say so. */
function originNote(s) {
  const modifiers = JSON.parse(s.modifiers || '[]');
  return modifiers.includes('generated') ? '  (derived, not written in this file)' : '';
}

function subtypesOf(db, symbolId) {
  return db
    .prepare(
      `SELECT s.name, s.fqn, s.kind, f.path AS file_path, s.start_line, e.kind AS rel
         FROM edges e
         JOIN symbols s ON s.id = e.from_symbol_id
         JOIN files f   ON f.id = s.file_id
        WHERE e.to_symbol_id = ? AND e.kind IN ('implements','extends')
        ORDER BY s.fqn`,
    )
    .all(symbolId);
}

function membersOf(db, containerFqn) {
  return db
    .prepare(
      `SELECT s.name, s.kind, s.signature, s.start_line, s.annotations
         FROM symbols s
        WHERE s.container_fqn = ? AND s.kind IN ('method','constructor','field')
        ORDER BY s.start_line`,
    )
    .all(containerFqn);
}

/**
 * The payload an agent gets back: verbatim source for the matched symbols plus
 * the call paths around them. Written as plain text because that is what lands
 * in a model's context most cheaply.
 */
export function formatExplore(db, root, query, { maxMatches = 3, maxLines = 120 } = {}) {
  const matches = searchSymbols(db, query, { limit: 12 });
  if (!matches.length) {
    return `No symbol matches "${query}".\n\nTry \`codelens query <partial-name>\` to browse what is indexed.`;
  }

  const out = [`# codelens explore: "${query}"`, ''];
  const shown = matches.slice(0, maxMatches);

  if (matches.length > shown.length) {
    out.push(
      `${matches.length} matches, showing ${shown.length}. Others: ` +
        matches
          .slice(maxMatches)
          .map((m) => m.fqn ?? m.name)
          .join(', '),
      '',
    );
  }

  for (const [i, sym] of shown.entries()) {
    out.push(`## Match ${i + 1}/${shown.length} — ${label(sym)}`);
    out.push(`${sym.file_path}:${sym.start_line}-${sym.end_line}${originNote(sym)}`, '');

    const src = symbolSource(root, sym, { maxLines });
    if (src) out.push('```' + sym.lang, src, '```', '');

    const isType = ['class', 'interface', 'enum', 'record'].includes(sym.kind);

    if (isType) {
      const subs = subtypesOf(db, sym.id);
      if (subs.length) {
        out.push(`### Implemented / extended by (${subs.length})`);
        for (const s of subs) out.push(`- ${s.fqn} — ${s.file_path}:${s.start_line}`);
        out.push('');
      }
      const members = membersOf(db, sym.fqn);
      if (members.length) {
        out.push(`### Members (${members.length})`);
        for (const m of members) {
          const ann = JSON.parse(m.annotations || '[]');
          out.push(
            `- ${m.kind} \`${m.signature}\`${ann.length ? ` @${ann.join(' @')}` : ''} (L${m.start_line})`,
          );
        }
        out.push('');
      }
    }

    const callers = callersOf(db, sym.id).filter((c) => CALL_KINDS.includes(c.edge_kind));
    if (callers.length) {
      out.push(`### Callers (${callers.length})`);
      for (const c of callers) {
        out.push(
          `- ${c.fqn} — ${c.file_path}${lineNote(c)}${kindNote(c)}${confidenceNote(c)}`,
        );
      }
      out.push('');
    }

    const callees = calleesOf(db, sym.id).filter((c) => CALL_KINDS.includes(c.edge_kind));
    if (callees.length) {
      out.push(`### Calls out to (${callees.length})`);
      for (const c of callees) {
        const from = c.lines?.length ? ` (from L${c.lines.join(', ')})` : '';
        out.push(
          `- ${c.fqn} — ${c.file_path}:${c.start_line}${kindNote(c)}${confidenceNote(c)}${from}`,
        );
      }
      out.push('');
    }

    // Links no call graph can see: a queue name, a route URI, a statement id.
    const wiredOut = calleesOf(db, sym.id).filter((c) => c.via?.startsWith('binding:'));
    const wiredIn = callersOf(db, sym.id).filter((c) => c.via?.startsWith('binding:'));
    if (wiredOut.length || wiredIn.length) {
      out.push('### Wired by framework');
      for (const c of wiredOut) {
        out.push(`- ${c.edge_kind} -> ${c.fqn} — ${c.file_path}:${c.start_line}${confidenceNote(c)}`);
      }
      for (const c of wiredIn) {
        out.push(`- ${c.fqn} ${c.edge_kind} this — ${c.file_path}:${c.start_line}${confidenceNote(c)}`);
      }
      out.push('');
    }

    const blast = impactOf(db, sym.id);
    if (blast.totalSymbols) {
      out.push(
        `### Blast radius`,
        `${blast.totalSymbols} symbol(s) across ${blast.totalFiles} file(s) transitively reach this.`,
        '',
      );
    }
  }

  return out.join('\n');
}

/** One symbol, in full, with its immediate call trail. */
export function formatNode(db, root, symbolId, { maxLines = 400 } = {}) {
  const sym = getSymbol(db, symbolId);
  if (!sym) return `No symbol with id ${symbolId}.`;

  const out = [`# ${label(sym)}`, `${sym.file_path}:${sym.start_line}-${sym.end_line}`, ''];
  const src = symbolSource(root, sym, { maxLines });
  if (src) out.push('```' + sym.lang, src, '```', '');

  const callers = callersOf(db, sym.id);
  const callees = calleesOf(db, sym.id);

  out.push(`### Callers (${callers.length})`);
  for (const c of callers) out.push(`- ${c.fqn} — ${loc(c)}${kindNote(c)}${confidenceNote(c)}`);
  out.push('', `### Callees (${callees.length})`);
  for (const c of callees) out.push(`- ${c.fqn} — ${loc(c)}${kindNote(c)}${confidenceNote(c)}`);

  return out.join('\n');
}

/**
 * One side of a symbol's relationships. Replaces slicing formatNode's output on
 * a heading string, which broke as soon as a heading was reworded.
 */
export function formatRelations(db, symbolId, direction) {
  const sym = getSymbol(db, symbolId);
  if (!sym) return `No symbol with id ${symbolId}.`;

  const rows = direction === 'callers' ? callersOf(db, sym.id) : calleesOf(db, sym.id);
  const calls = rows.filter((r) => CALL_KINDS.includes(r.edge_kind));
  const other = rows.filter((r) => !CALL_KINDS.includes(r.edge_kind));

  const name = sym.fqn ?? sym.name;
  const out = [
    direction === 'callers' ? `# Callers of ${name}` : `# What ${name} calls`,
    loc(sym),
    '',
  ];

  if (!calls.length && !other.length) {
    out.push(
      direction === 'callers'
        ? 'Nothing calls this symbol — it is a leaf or an entry point.'
        : 'This symbol calls nothing that is indexed.',
    );
    return out.join('\n');
  }

  if (calls.length) {
    out.push(direction === 'callers' ? `### Callers (${calls.length})` : `### Calls out to (${calls.length})`);
    for (const c of calls) {
      const where = direction === 'callers' ? lineNote(c) : `:${c.start_line}`;
      out.push(`- ${c.fqn} — ${c.file_path}${where}${kindNote(c)}${confidenceNote(c)}`);
    }
    out.push('');
  }

  if (other.length) {
    out.push(`### Other relationships (${other.length})`);
    for (const c of other) {
      out.push(`- ${c.edge_kind}: ${c.fqn} — ${loc(c)}${confidenceNote(c)}`);
    }
  }

  return out.join('\n');
}

/**
 * Answers the question a diff raises: I touched these files, what does that
 * reach and which tests already exercise it.
 */
export function formatAffected(db, relPaths, { maxDepth = 4 } = {}) {
  const { changed, reached, tests, missingFiles } = affectedBy(db, relPaths, { maxDepth });

  const out = [`# Affected by ${relPaths.length} changed file(s)`, ''];

  if (missingFiles.length) {
    out.push(
      `Not in the index (${missingFiles.length}): ${missingFiles.slice(0, 10).join(', ')}` +
        (missingFiles.length > 10 ? ` and ${missingFiles.length - 10} more` : ''),
      '',
    );
  }

  if (!changed.length) {
    out.push('No indexed symbols in those files.');
    return out.join('\n');
  }

  out.push(`### Changed symbols (${changed.length})`);
  for (const s of changed) out.push(`- ${s.kind} ${s.fqn ?? s.name} — ${loc(s)}`);
  out.push('');

  const byFile = new Map();
  for (const s of reached) {
    if (!byFile.has(s.file_path)) byFile.set(s.file_path, []);
    byFile.get(s.file_path).push(s);
  }

  out.push(`### Reached (${reached.length} symbol(s) in ${byFile.size} file(s))`);
  if (!reached.length) out.push('Nothing outside the changed files reaches this.');
  for (const [file, symbols] of [...byFile.entries()].sort()) {
    out.push(`- ${file} — ${symbols.map((s) => s.name).join(', ')}`);
  }
  out.push('');

  out.push(`### Tests that already cover it (${tests.length})`);
  if (!tests.length) {
    out.push('None found — a change here is not covered by any test this index can see.');
  }
  for (const t of tests) out.push(`- ${t.fqn ?? t.name} — ${loc(t)}`);

  return out.join('\n');
}

export function formatImpact(db, symbolId) {
  const sym = getSymbol(db, symbolId);
  if (!sym) return `No symbol with id ${symbolId}.`;
  const { levels, totalSymbols, totalFiles } = impactOf(db, symbolId);

  const out = [
    `# Impact of changing ${sym.fqn ?? sym.name}`,
    `${loc(sym)}`,
    '',
    `${totalSymbols} symbol(s) across ${totalFiles} file(s) can reach this.`,
    '',
  ];

  levels.forEach((level, i) => {
    if (!level?.length) return;
    out.push(`### Depth ${i + 1} (${level.length})`);
    for (const s of level) out.push(`- ${s.fqn} — ${loc(s)}${confidenceNote(s)}`);
    out.push('');
  });

  if (!totalSymbols) out.push('Nothing calls this symbol — it is a leaf or an entry point.');
  return out.join('\n');
}

/**
 * The graph as Mermaid, for pasting into a README, a PR description, or any
 * Markdown renderer. Symbols become short node ids; the human-readable name
 * goes in the label, quoted so Mermaid never parses it as syntax.
 */
export function toMermaid(graph) {
  const label = (n) => (n.fqn ?? n.name).replace(/"/g, '#quot;');
  const lines = ['flowchart LR'];

  for (const n of graph.nodes) {
    // Three shapes carry the three things worth telling apart at a glance:
    // stadium for types, rectangle for members, hexagon for derived symbols.
    const shape = n.derived
      ? `{{"${label(n)}"}}`
      : ['class', 'interface', 'enum', 'record', 'module'].includes(n.kind)
        ? `(["${label(n)}"])`
        : `["${label(n)}"]`;
    lines.push(`  n${n.id}${shape}`);
  }
  for (const e of graph.edges) {
    const note = e.kind && !CALL_KINDS.includes(e.kind) ? `-- ${e.kind} -->` : '-->';
    lines.push(`  n${e.from} ${note} n${e.to}`);
  }
  if (graph.truncated) lines.push('  %% truncated: the neighbourhood was larger than the cap');
  return lines.join('\n');
}

/** One symbol's display name and location, straight from its index. */
export function symbolLabel(db, id) {
  const s = db
    .prepare(`SELECT s.fqn, s.name, f.path AS file_path, s.start_line
                FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`)
    .get(id);
  return s ? { label: s.fqn ?? s.name, at: `${s.file_path}:${s.start_line}` } : null;
}

/**
 * The body of a chain -- start line plus one indented hop per link -- with no
 * header or verdict, so a cross-repository path can splice two of these
 * around the binding that bridges them.
 */
export function pathLines(db, fromId, result) {
  const start = symbolLabel(db, fromId);
  const out = [`${start.label} — ${start.at}`];
  for (const hop of result.hops) {
    const conf = hop.confidence != null && hop.confidence < 1 ? ` · ${hop.confidence.toFixed(2)}` : '';
    const label = hop.kind && !CALL_KINDS.includes(hop.kind) ? hop.kind : 'calls';
    out.push(`  └─ ${label} [${hop.via}${conf}]`);
    out.push(`${hop.symbol.fqn ?? hop.symbol.name} — ${hop.symbol.file_path}:${hop.symbol.start_line}`);
  }
  return out;
}

/** The chain from one symbol to another, one hop per line. */
export function formatPath(db, fromId, toId, result) {
  const start = symbolLabel(db, fromId);
  const goal = symbolLabel(db, toId);
  const out = [`# Path: ${start.label} → ${goal.label}`, ''];

  if (!result) {
    out.push('No directed path: nothing this symbol calls ever reaches the target.');
    out.push('(Edges run the way the code runs — try swapping the two ends.)');
    return out.join('\n');
  }
  if (!result.length) {
    out.push('They are the same symbol.');
    return out.join('\n');
  }

  out.push(...pathLines(db, fromId, result));
  out.push('', `${result.length} hop(s).`);
  return out.join('\n');
}
