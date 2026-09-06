/**
 * Three questions a graph can answer that a search cannot.
 *
 *   dead     -- what does nothing reach?
 *   cycles   -- what depends on itself, the long way round?
 *   hotspots -- what would hurt most to change?
 *
 * All three read only the resolved graph. None of them guesses: where the
 * index cannot see far enough to be sure, the answer says so and leaves the
 * symbol out, because a wrong answer here is a deleted function or a refactor
 * aimed at the wrong file.
 */
import { readFileSync, readdirSync, openSync, fstatSync, closeSync } from 'node:fs';
import { join, extname } from 'node:path';
import { isTestPath } from './query.js';

/**
 * Files that call code by NAME rather than by a call expression: a template
 * writes `${owner.address}` and the compiler never sees a call at all. These
 * have no grammar here and never will, but they can still be read as text --
 * and reading them is the difference between a shortlist worth acting on and
 * one that tells you to delete a getter the page depends on.
 */
const NAME_BEARING = new Set([
  '.html', '.htm', '.erb', '.haml', '.slim', '.jsp', '.vue', '.svelte',
  '.xml', '.yml', '.yaml', '.json', '.ftl', '.mustache', '.hbs', '.ejs', '.pug',
]);
const MAX_TEMPLATE_BYTES = 512 * 1024;

/**
 * Every bare word in the repository's templates and config.
 *
 * Deliberately coarse: this exists only to REMOVE things from an accusation,
 * so a word appearing that happens to match an unrelated method costs nothing
 * but a symbol staying off the list. Being wrong in the other direction costs
 * someone their working page.
 */
function namesInTemplates(root, { maxFiles = 3000 } = {}) {
  const words = new Set();
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 8 || seen >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen >= maxFiles) return;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!NAME_BEARING.has(extname(e.name).toLowerCase())) continue;
      try {
        // Size and contents read through one descriptor: `statSync` then
        // `readFileSync` names the path twice, and the size that decided the
        // file was small enough belonged to whatever was there the first time.
        const fd = openSync(full, 'r');
        try {
          if (fstatSync(fd).size > MAX_TEMPLATE_BYTES) continue;
          for (const w of readFileSync(fd, 'utf8').match(/[A-Za-z_$][\w$]*/g) ?? []) {
            words.add(w);
          }
        } finally {
          closeSync(fd);
        }
        seen++;
      } catch {
        /* unreadable file: one fewer word, not a failure */
      }
    }
  };
  walk(root, 0);
  return words;
}

/** `getAddress` -> ['getAddress', 'address']; `isReady` -> [..., 'ready']. */
function nameForms(name) {
  const forms = [name];
  const bean = /^(get|is|set|has)([A-Z].*)$/.exec(name);
  if (bean) {
    const bare = bean[2];
    forms.push(bare, bare[0].toLowerCase() + bare.slice(1));
  }
  return forms;
}

const SYMBOL_COLS = `s.id, s.name, s.fqn, s.kind, s.container_fqn, s.signature,
  s.start_line, s.end_line, s.annotations, s.modifiers, f.path AS file_path, f.lang`;

/**
 * Annotations and modifiers that mean "something outside this graph calls it".
 * A framework entry point has no caller in the source and is emphatically not
 * dead: deleting a @Scheduled method because nothing calls it would take the
 * job with it.
 */
const CALLED_BY_FRAMEWORK = [
  // Spring, JAX-RS, Jakarta
  'Bean', 'Component', 'Controller', 'RestController', 'Service', 'Repository',
  'Configuration', 'Scheduled', 'EventListener', 'PostConstruct', 'PreDestroy',
  'RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping',
  'PatchMapping', 'ExceptionHandler', 'InitBinder', 'ModelAttribute',
  'SqsListener', 'KafkaListener', 'RabbitListener', 'JmsListener', 'Transactional',
  'Override', 'Test', 'BeforeEach', 'AfterEach', 'BeforeAll', 'AfterAll',
  'ParameterizedTest', 'RepeatedTest', 'Path', 'GET', 'POST', 'PUT', 'DELETE',
  // NestJS and friends
  'Injectable', 'Module', 'Get', 'Post', 'Put', 'Delete', 'Patch', 'Cron',
  'SqsMessageHandler', 'OnEvent', 'UseGuards', 'Entity',
];

/** Ruby and JS names that a runtime, not the source, is expected to call. */
const RUNTIME_NAMES = new Set([
  'initialize', 'main', 'call', 'to_s', 'inspect', 'each', 'method_missing',
  'respond_to_missing?', 'included', 'extended', 'inherited', 'up', 'down',
  'change', 'constructor', 'render', 'toString', 'valueOf', 'default',
]);

function hasFrameworkMarker(row) {
  let annotations = [];
  try {
    annotations = JSON.parse(row.annotations || '[]');
  } catch {
    annotations = [];
  }
  const names = annotations.map((a) => String(a).replace(/^@/, '').split('(')[0]);
  if (names.some((n) => CALLED_BY_FRAMEWORK.includes(n))) return true;

  // An abstract or interface member is implemented elsewhere and called
  // through the declaration.
  return modifiersOf(row).some((m) => ['abstract', 'external'].includes(m));
}

function modifiersOf(row) {
  try {
    return JSON.parse(row.modifiers || '[]');
  } catch {
    return [];
  }
}

/**
 * Exported, or public: reachable from outside this repository, so held back
 * unless asked for. `export` used to count as a framework marker and was
 * dropped before `--public` could ask, which left that flag unable to show
 * the very names its help text promised.
 */
function isPublic(row) {
  const modifiers = modifiersOf(row);
  if (modifiers.some((m) => ['export', 'default'].includes(m))) return true;
  return !(/(^_|^private)/.test(row.name) || modifiers.includes('private'));
}

/**
 * Symbols nothing in this repository reaches.
 *
 * The honest version of "dead code", which means being clear about what this
 * cannot know. A symbol is only reported when the graph is in a position to
 * be sure: it is a method or function, nothing calls it, no framework
 * annotation marks it as an entry point, it is not a test, and it is not one
 * of the names a runtime calls without the source ever saying so.
 *
 * Even then this is a shortlist to READ, not a delete list. Reflection,
 * dynamic dispatch by string, a template calling a helper by name, and any
 * call this index failed to resolve all look exactly like "nothing calls it".
 * The count of unresolved calls is reported alongside for that reason.
 */
export function deadCode(db, root, { limit = 50, includeTests = false, onlyCertain = true } = {}) {
  const rows = db
    .prepare(
      `SELECT ${SYMBOL_COLS}
         FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.external = 0
          AND s.kind IN ('method', 'class_method', 'function')
          AND s.fqn IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.to_symbol_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM bindings b WHERE b.symbol_id = s.id)
        ORDER BY f.path, s.start_line`,
    )
    .all();

  // Only pay for the template scan when there is something to rule out.
  const templateWords = rows.length && root ? namesInTemplates(root) : new Set();

  const candidates = [];
  let namedInTemplate = 0;
  for (const row of rows) {
    if (!includeTests && isTestPath(row.file_path)) continue;
    if (RUNTIME_NAMES.has(row.name)) continue;
    if (hasFrameworkMarker(row)) continue;
    // A template naming it IS a call, just not one any grammar here can see.
    if (nameForms(row.name).some((f) => templateWords.has(f))) {
      namedInTemplate++;
      continue;
    }
    // A private helper nothing calls is the strongest case there is: nothing
    // outside the file could be calling it, so the graph has seen everything
    // there is to see. A public one may simply be somebody else's API --
    // sinatra has 225 of those, and every one is a working entry point.
    candidates.push({ ...row, confidence: isPublic(row) ? 'medium' : 'high' });
  }

  candidates.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'high' ? -1 : 1));

  // When nothing is certain, say nothing rather than falling back to the full
  // list. A library's whole API is unreached from inside itself, and printing
  // 225 working entry points as suspects is worse than printing none.
  const certain = candidates.filter((c) => c.confidence === 'high');
  const shown = onlyCertain ? certain : candidates;

  // How much this repository could not resolve is how much this list is worth.
  const unresolved = db
    .prepare('SELECT COUNT(*) AS n FROM unresolved WHERE external = 0')
    .get().n;
  const refs = db.prepare('SELECT COUNT(*) AS n FROM refs').get().n;

  return {
    candidates: shown.slice(0, limit),
    total: shown.length,
    // How many were held back for being reachable from outside the repository.
    publicHeldBack: onlyCertain ? candidates.length - certain.length : 0,
    namedInTemplate,
    unresolved,
    refs,
  };
}

/**
 * Cycles between FILES, which is the level a dependency cycle is felt at:
 * two modules that each import the other cannot be understood, tested, or
 * extracted separately.
 *
 * Method-level recursion is normal and is not reported. A file-level cycle
 * almost never is.
 */
export function cycles(db, { limit = 30, maxLength = 6 } = {}) {
  const edges = db
    .prepare(
      `SELECT DISTINCT ff.path AS src, tf.path AS dst
         FROM edges e
         JOIN symbols fs ON fs.id = e.from_symbol_id
         JOIN symbols ts ON ts.id = e.to_symbol_id
         JOIN files ff ON ff.id = fs.file_id
         JOIN files tf ON tf.id = ts.file_id
        WHERE ff.path != tf.path AND ff.external = 0 AND tf.external = 0`,
    )
    .all();

  const out = new Map();
  for (const { src, dst } of edges) {
    if (!out.has(src)) out.set(src, new Set());
    out.get(src).add(dst);
  }

  // Iterative depth-first search with the current stack as the path, which is
  // what makes the cycle printable rather than merely detectable.
  const found = [];
  const seen = new Set();
  const inStack = new Set();
  const stack = [];

  const visit = (node, depth) => {
    if (found.length >= limit || depth > maxLength) return;
    inStack.add(node);
    stack.push(node);
    for (const next of out.get(node) ?? []) {
      if (found.length >= limit) break;
      if (inStack.has(next)) {
        const at = stack.indexOf(next);
        if (at !== -1) {
          const ring = stack.slice(at);
          // One cycle, one report: rotate to a canonical start so A->B->A and
          // B->A->B are not two findings.
          const lowest = ring.indexOf([...ring].sort()[0]);
          const canonical = [...ring.slice(lowest), ...ring.slice(0, lowest)];
          const key = canonical.join(' -> ');
          if (!seen.has(key)) {
            seen.add(key);
            found.push(canonical);
          }
        }
        continue;
      }
      visit(next, depth + 1);
    }
    stack.pop();
    inStack.delete(node);
  };

  for (const node of out.keys()) {
    if (found.length >= limit) break;
    visit(node, 0);
  }
  return found;
}

/**
 * What would hurt most to change: the symbols the most other code depends on,
 * counted by callers rather than by total degree.
 *
 * `topHubs` ranks by degree, which rewards a class that calls a great many
 * things. That is a big class, not a dangerous one. What makes a change
 * dangerous is how many places depend on IT, so this counts one direction
 * only, and reports how much of the repository each one reaches.
 */
export function hotspots(db, { limit = 20 } = {}) {
  return db
    .prepare(
      `SELECT ${SYMBOL_COLS},
              (SELECT COUNT(DISTINCT e.from_symbol_id) FROM edges e
                WHERE e.to_symbol_id = s.id) AS callers,
              (SELECT COUNT(DISTINCT fs.file_id) FROM edges e
                 JOIN symbols fs ON fs.id = e.from_symbol_id
                WHERE e.to_symbol_id = s.id) AS caller_files
         FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.external = 0 AND s.fqn IS NOT NULL
          AND s.kind IN ('method', 'class_method', 'function', 'class', 'interface')
        ORDER BY callers DESC, caller_files DESC, s.name
        LIMIT ?`,
    )
    .all(limit)
    .filter((r) => r.callers > 0);
}
