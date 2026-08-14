import {
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
    out.push(`${sym.file_path}:${sym.start_line}-${sym.end_line}`, '');

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

    const callers = callersOf(db, sym.id).filter((c) => c.edge_kind === 'calls');
    if (callers.length) {
      out.push(`### Callers (${callers.length})`);
      for (const c of callers) {
        out.push(`- ${c.fqn} — ${c.file_path}:${c.call_line ?? c.start_line}${confidenceNote(c)}`);
      }
      out.push('');
    }

    const callees = calleesOf(db, sym.id).filter((c) => c.edge_kind === 'calls');
    if (callees.length) {
      out.push(`### Calls out to (${callees.length})`);
      for (const c of callees) {
        out.push(`- ${c.fqn} — ${c.file_path}:${c.start_line}${confidenceNote(c)} (from L${c.call_line})`);
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
  for (const c of callers) out.push(`- ${c.fqn} — ${loc(c)}${confidenceNote(c)}`);
  out.push('', `### Callees (${callees.length})`);
  for (const c of callees) out.push(`- ${c.fqn} — ${loc(c)}${confidenceNote(c)}`);

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
