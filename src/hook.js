/**
 * What Claude Code's hooks hand this tool, and what it hands back.
 *
 * The point of the index is that an agent implementing a change knows what
 * the change reaches. Asking it to remember to look is the weak link, so a
 * hook does the looking: after every Edit or Write, the file's blast radius
 * and the tests already covering it are put in front of the agent unasked.
 *
 * The contract, from the hooks documentation rather than from memory, since
 * memory had it wrong:
 *
 *   PostToolUse   exit 0 -> stdout goes to the debug log; Claude never sees it.
 *                 exit 2 -> stderr is shown to Claude; the tool already ran,
 *                           so nothing is blocked. That is the only channel.
 *   SessionStart  exit 0 -> plain-text stdout becomes context Claude sees.
 *
 * Both are silent when there is nothing to say: no index, a file outside it,
 * a file with no symbols. A hook that talks on every keystroke is muted.
 */
import { dirname } from 'node:path';
import { openProject } from './db.js';
import { findProjectRoot, dbPathFor, changedPath } from './project.js';
import { affectedBy, projectStats } from './query.js';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Names shown per list. Enough to act on; small enough not to drown the reply. */
const SHOW = 6;

/** Reads every byte of stdin, which is how a hook receives its event. */
export function readEvent(stream = process.stdin) {
  return new Promise((done) => {
    let raw = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => (raw += c));
    stream.on('end', () => {
      try {
        done(JSON.parse(raw));
      } catch {
        done(null);
      }
    });
    stream.on('error', () => done(null));
  });
}

const few = (rows, pick) => {
  const names = rows.slice(0, SHOW).map(pick);
  return rows.length > SHOW ? `${names.join(', ')} … +${rows.length - SHOW}` : names.join(', ');
};

/**
 * The message for one edited file, or null when there is nothing worth
 * saying. Pure: takes the rows, returns text, so it can be tested without a
 * process or a stream.
 */
export function afterEdit(db, root, filePath) {
  const rel = changedPath(root, filePath, {
    known: (p) => !!db.prepare('SELECT 1 FROM files WHERE path = ?').get(p),
  });
  const { changed, reached, tests } = affectedBy(db, [rel], { maxDepth: 4 });
  if (!changed.length) return null;

  const files = new Set(reached.map((s) => s.file_path));
  const lines = [
    `provenlens · ${rel}: ${changed.length} symbol(s) here reach ${reached.length} symbol(s) in ${files.size} other file(s)`,
  ];
  if (reached.length) lines.push(`  reached: ${few(reached, (s) => s.fqn ?? s.name)}`);
  lines.push(
    tests.length
      ? `  covered by ${tests.length} test(s): ${few(tests, (t) => t.fqn ?? t.name)}`
      : '  covered by: no existing test reaches this — decide whether the change needs one',
  );
  lines.push('  (provenlens_impact <name> for the full radius; index is as of the last sync)');
  return lines.join('\n');
}

/** One paragraph of orientation for a session that opens on an indexed repo. */
export function atSessionStart(db, root) {
  const s = projectStats(db);
  const external = db.prepare('SELECT COUNT(*) AS n FROM unresolved WHERE external = 1').get().n;
  const linked = s.refs - s.unresolved;
  const inRepo = s.refs - external;
  const pct = inRepo ? ((linked / inRepo) * 100).toFixed(1) : '0.0';
  return [
    `provenlens index present at ${root}: ${s.files} files, ${s.symbols} symbols, ${pct}% of in-repo calls linked.`,
    'Before grep or reading files to answer "who calls what", use provenlens_explore / provenlens_impact,',
    'and after editing, the hook will report what each file reaches. `provenlens status` says how fresh it is.',
  ].join(' ');
}

/**
 * Handles one event end to end and returns the exit code to use. Writes to
 * the given streams so a test can capture them.
 */
export async function runHook(event, { out = process.stdout, err = process.stderr } = {}) {
  if (!event || typeof event !== 'object') return 0;

  if (event.hook_event_name === 'SessionStart') {
    const root = findProjectRoot(event.cwd ?? process.cwd());
    if (!root) return 0;
    const { db, staleSchema } = openProject(dbPathFor(root));
    try {
      if (staleSchema) return 0;
      out.write(`${atSessionStart(db, root)}\n`);
    } finally {
      db.close();
    }
    return 0;
  }

  if (event.hook_event_name === 'PostToolUse' && FILE_TOOLS.has(event.tool_name)) {
    const file = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
    if (!file) return 0;
    const root = findProjectRoot(dirname(file));
    if (!root) return 0;
    const { db, staleSchema } = openProject(dbPathFor(root));
    try {
      if (staleSchema) return 0;
      const message = afterEdit(db, root, file);
      if (!message) return 0;
      // Exit 2 is the documented way to put text in front of Claude after a
      // tool has run. It blocks nothing: the edit is already on disk.
      err.write(`${message}\n`);
      return 2;
    } finally {
      db.close();
    }
  }

  return 0;
}
