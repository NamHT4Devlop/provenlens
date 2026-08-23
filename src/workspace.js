/**
 * Several indexed repositories treated as one workspace.
 *
 * The CLI and the MCP server both want what the web UI already had: point at
 * a folder of service checkouts and ask questions across all of them. The
 * pieces that are pure lookup live here so the three frontends cannot drift.
 */
import { basename } from 'node:path';
import { openProject } from './db.js';
import { discoverProjects, dbPathFor } from './project.js';
import { searchSymbols, pathBetween } from './query.js';

/**
 * Opens every indexed repository under (or at) each of the given paths.
 * Read-only: no sync, no watcher -- callers that need freshness add their own.
 */
export function openWorkspace(paths) {
  const roots = [...new Set((Array.isArray(paths) ? paths : [paths]).flatMap((p) => discoverProjects(p)))].sort();
  return roots.map((root, id) => ({
    id,
    name: basename(root),
    root,
    db: openProject(dbPathFor(root)).db,
  }));
}

/** The best match for a name, searched repo by repo in workspace order. */
export function locateSymbol(projects, name) {
  for (const project of projects) {
    const hit = searchSymbols(project.db, name, { limit: 1 })[0];
    if (hit) return { project, hit };
  }
  return null;
}

/**
 * A directed chain between two located symbols, wherever they live.
 *
 * Inside one repository this is plain BFS. Across two, the only bridges are
 * framework bindings -- a queue name, an endpoint URI -- so the chain is
 * walked to a binding endpoint on one side, matched by key on the other, and
 * continued from there. Shortest total wins.
 */
export function pathAcross(a, b) {
  if (a.project.id === b.project.id || a.project.root === b.project.root) {
    const found = pathBetween(a.project.db, a.hit.id, b.hit.id);
    return found ? { same: true, found } : null;
  }

  const pairs = a.project.db
    .prepare(`SELECT plugin, role, key, symbol_id FROM bindings`)
    .all()
    .flatMap((mine) =>
      b.project.db
        .prepare(`SELECT symbol_id FROM bindings WHERE plugin = ? AND key = ? AND role != ?`)
        .all(mine.plugin, mine.key, mine.role)
        .map((theirs) => ({ mine, theirs })),
    );

  let best = null;
  for (const { mine, theirs } of pairs) {
    const first = pathBetween(a.project.db, a.hit.id, mine.symbol_id);
    if (!first) continue;
    const second = pathBetween(b.project.db, theirs.symbol_id, b.hit.id);
    if (!second) continue;
    const total = first.length + 1 + second.length;
    if (!best || total < best.total) best = { same: false, mine, theirs, first, second, total };
  }
  return best;
}
