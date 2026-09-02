/**
 * Type signatures from compiled Java, read with `javap`.
 *
 * The Java half of what `.d.ts` does for TypeScript: a receiver typed by
 * `Mono<User>` or `Optional<Post>` has its type declared in a JAR, so without
 * reading one the chain stops there and everything downstream is a miss.
 *
 * `javap` is part of every JDK and prints exactly what is needed -- return
 * types, parameter types and generic arguments -- as text the same parser can
 * read. Parsing class files directly would be a great deal of work to learn
 * the same facts.
 *
 * As with `.d.ts`, what is read is not the project's code: the entries are
 * marked external, are never resolution targets, and never enter a count.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Each javap run reopens the whole classpath, so the cost is per *invocation*
 * far more than per class. Bigger batches mean fewer of them: on halo this is
 * the difference between a dozen runs over 400 jars and a handful.
 */
const BATCH = 250;
const MAX_TYPES = 4000;

/**
 * The `java.lang` classes a call is most likely to land on.
 *
 * No import ever names these -- the language imports them into every file --
 * so the search for unread types never asks about them, and a project that
 * declares a nested class by the same name silently answers for them instead.
 * spring-boot has a `System`, jackson-databind a `Double`.
 *
 * A fixed list rather than a scan: java.lang is a stable, closed API, and
 * asking about the whole of it costs a single javap batch. Deriving the names
 * from the source instead means competing with the imports for the cap above,
 * which measurably costs more than it wins.
 */
const JAVA_LANG = [
  'Object', 'String', 'Class', 'System', 'Math', 'Thread', 'Runnable', 'Enum', 'Record',
  'Integer', 'Long', 'Double', 'Float', 'Short', 'Byte', 'Boolean', 'Character', 'Number',
  'Throwable', 'Exception', 'RuntimeException', 'Error', 'StringBuilder', 'StringBuffer',
  'Iterable', 'Comparable', 'CharSequence', 'Cloneable', 'AutoCloseable', 'Appendable',
  'Void', 'Package', 'Process', 'ProcessBuilder', 'ClassLoader', 'Runtime', 'ThreadLocal',
  'StackTraceElement', 'ThreadGroup', 'SecurityManager', 'Readable',
].map((n) => `java.lang.${n}`);
/** A shared cache can hold a great many jars that this project never asked for. */
const MAX_JARS = 4000;

/**
 * `public static <T> java.util.Optional<T> of(T)` ->
 * { name: 'of', returns: 'java.util.Optional', args: 'T', arity: 1 }
 *
 * Constructors and fields are skipped: a chain is carried by return types.
 */
function readMember(line) {
  const text = line.trim().replace(/;$/, '');
  if (!text || text.startsWith('static {') || text.includes(' class ') || text.includes(' interface ')) {
    return null;
  }
  const call = /([A-Za-z_$][\w$.]*)\(([^)]*)\)$/.exec(text);
  if (!call) return null;

  const name = call[1].split('.').pop();
  const before = text.slice(0, call.index).trim();
  // Everything before the name is modifiers, then optionally a type parameter
  // list, then the return type. The last token of that is what it returns.
  const returns = before.replace(/^.*>\s+/, '').split(/\s+/).pop() ?? '';
  if (!returns || returns === name) return null; // a constructor

  // Parameter types matter as much as the return type: `configure(Consumer<
  // ContainerOptions>)` is the only place a lambda's parameter is named, and
  // that shape is most of what a Spring test harness is made of.
  const params = splitTopLevel(call[2]);
  return { name, returns, arity: params.length, params };
}

/**
 * Splits an argument list on commas that are not inside a generic argument:
 * `Consumer<Map<K,V>>, String` is two parameters, not four.
 */
function splitTopLevel(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (c === ',' && depth === 0) {
      out.push(trimmed.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(trimmed.slice(start).trim());
  return out.filter(Boolean);
}

/** `java.util.Optional<T>` -> { erased, arg } */
function splitGeneric(raw) {
  const lt = raw.indexOf('<');
  if (lt === -1) return { erased: raw.replace(/\[\]$/, ''), arg: null };
  const erased = raw.slice(0, lt);
  const inner = raw.slice(lt + 1, raw.lastIndexOf('>')).trim();
  const arg = !inner || inner.includes(',') || inner.includes('<') ? null : inner;
  return { erased, arg };
}

/**
 * Runs javap over a batch of fully qualified names and returns one entry per
 * class it could read. A name javap does not know is simply absent -- that is
 * the answer for a dependency the project never downloaded.
 */
export function readSignatures(fqns, classpath) {
  if (!fqns.length) return [];
  const args = classpath ? ['-cp', classpath, ...fqns] : [...fqns];
  let out;
  try {
    out = execFileSync('javap', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // javap exits non-zero when any name is unknown, but still prints the
    // ones it did find, so its output is worth keeping.
    out = err.stdout ?? '';
  }

  const classes = [];
  let current = null;
  for (const line of out.split('\n')) {
    const header = /^(?:[\w\s]*\s)?(?:class|interface|enum|@interface)\s+([\w$.]+)/.exec(line);
    if (header && !line.startsWith(' ')) {
      current = { fqn: header[1], members: [] };
      classes.push(current);
      continue;
    }
    if (!current || !line.startsWith(' ')) continue;
    const member = readMember(line);
    if (member) current.members.push(member);
  }
  return classes;
}

/**
 * Type names the project refers to but does not declare: the imports that
 * resolved to nothing. These are exactly the types whose members a chain
 * needs and cannot see.
 */
export function unresolvedImports(db) {
  const declared = new Set(
    db.prepare("SELECT fqn FROM types").all().map((r) => r.fqn),
  );
  const declaredSimple = new Set([...declared].map((fqn) => fqn.split('.').pop()));

  const wanted = db
    .prepare(
      `SELECT DISTINCT i.fqn FROM imports i JOIN files f ON f.id = i.file_id
        WHERE f.lang = 'java' AND f.external = 0 AND i.is_wildcard = 0`,
    )
    .all()
    .map((r) => r.fqn)
    .filter((fqn) => fqn && !declared.has(fqn));

  // `java.lang` is imported implicitly, so no import ever names it and this
  // search never asked about it. That left `catch (Exception e)` untyped --
  // 1,677 such locals in dubbo alone, and every `e.getMessage()` on them a
  // miss. Any simple name the project uses as a type and does not declare is
  // offered to javap as a java.lang candidate; javap knows which are real,
  // and simply omits the rest, so nothing here is a guess.
  const used = db
    .prepare(
      `SELECT DISTINCT type_name AS name FROM locals l JOIN files f ON f.id = l.file_id
        WHERE f.lang = 'java' AND type_name IS NOT NULL
       UNION
       SELECT DISTINCT type_name FROM symbols s JOIN files f ON f.id = s.file_id
        WHERE f.lang = 'java' AND f.external = 0 AND type_name IS NOT NULL`,
    )
    .all()
    .map((r) => r.name);

  const implicit = [];
  for (const raw of used) {
    const simple = raw.replace(/\[\]$/, '');
    if (!/^[A-Z][A-Za-z0-9_$]*$/.test(simple)) continue;
    if (declaredSimple.has(simple)) continue;
    implicit.push(`java.lang.${simple}`);
  }

  // `Map.Entry` is written as a nested name and lives in a jar as
  // `java.util.Map$Entry`, which no import ever spells. Every
  // `for (Map.Entry<K,V> entry : ...)` was left untyped for want of it --
  // 1,062 calls on `entry` in quarkus, 435 in dubbo. The outer half is a name
  // some import does resolve, so the inner half can be asked for by hand.
  const importedFqns = new Map();
  for (const row of db
    .prepare(
      `SELECT DISTINCT i.fqn, i.simple FROM imports i JOIN files f ON f.id = i.file_id
        WHERE f.lang = 'java' AND f.external = 0 AND i.is_wildcard = 0 AND i.simple IS NOT NULL`,
    )
    .all()) {
    if (!importedFqns.has(row.simple)) importedFqns.set(row.simple, row.fqn);
  }

  const nested = [];
  for (const raw of used) {
    const bare = raw.replace(/\[\]$/, '');
    const parts = bare.split('.');
    if (parts.length !== 2) continue;
    const [outer, inner] = parts;
    if (!/^[A-Z][A-Za-z0-9_$]*$/.test(outer) || !/^[A-Z][A-Za-z0-9_$]*$/.test(inner)) continue;
    const outerFqn = importedFqns.get(outer);
    if (outerFqn) nested.push(`${outerFqn}$${inner}`);
    // `Map.Entry` needs no import of `Map.Entry` itself, and java.util is the
    // only place the language puts the ones written this way without one.
    nested.push(`java.util.${outer}$${inner}`);
  }

  // Appended after the cap, not folded into it, so they never displace an import.
  return [...new Set([...wanted, ...implicit, ...nested])]
    .slice(0, MAX_TYPES)
    .concat(JAVA_LANG);
}

/**
 * Every jar a build tool has already downloaded.
 *
 * The caches are shared between projects, so this necessarily includes jars
 * another project asked for. javap ignores what it does not need, but it does
 * pay to open each one, so the total is capped -- 285 unrelated Maven jars
 * added ten seconds to indexing halo before this was noticed.
 */
export function classpathFor(root) {
  const jars = [];
  const roots = [
    join(root, 'build', 'libs'),
    join(root, 'target'),
    join(homedir(), '.m2', 'repository'),
    join(homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1'),
  ].filter((d) => existsSync(d));

  const walk = (dir, depth) => {
    if (depth > 8 || jars.length >= MAX_JARS) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (jars.length >= MAX_JARS) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (
        e.name.endsWith('.jar') &&
        !e.name.endsWith('-sources.jar') &&
        !e.name.endsWith('-javadoc.jar')
      ) {
        try {
          if (statSync(full).size > 0) jars.push(full);
        } catch {
          /* vanished between listing and stat */
        }
      }
    }
  };
  for (const d of roots) walk(d, 0);
  return jars.join(':');
}

/**
 * Reads the signatures of every type this project imports but does not
 * declare, and writes them as external symbols.
 */
export function indexJvm(db, root) {
  const wanted = unresolvedImports(db);
  if (!wanted.length) return { types: 0, members: 0 };

  const classpath = classpathFor(root);
  const insertFile = db.prepare(
    `INSERT INTO files (path, lang, hash, pkg, lines, indexed_at, external, owner)
     VALUES (?, 'java', '', ?, 0, ?, 1, ?)`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbols
       (file_id, name, fqn, kind, container_fqn, type_name, type_args, signature, arity, params,
        start_line, end_line, start_byte, end_byte, modifiers, annotations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, '["external"]', '[]')`,
  );
  const insertType = db.prepare(
    'INSERT OR REPLACE INTO types (fqn, symbol_id, kind, supertypes) VALUES (?, ?, ?, ?)',
  );

  const stats = { types: 0, members: 0 };
  for (let i = 0; i < wanted.length; i += BATCH) {
    const batch = wanted.slice(i, i + BATCH);
    let classes;
    try {
      classes = readSignatures(batch, classpath);
    } catch {
      continue;
    }

    for (const cls of classes) {
      // The owning artefact is not knowable from javap, so the package root
      // stands in: it is what an unresolved call would have been blamed on.
      const owner = cls.fqn.split('.').slice(0, 3).join('.');
      const fileId = Number(
        insertFile.run(`jvm:${cls.fqn}`, cls.fqn, Date.now(), owner).lastInsertRowid,
      );
      const typeId = Number(
        insertSymbol.run(
          fileId, cls.fqn.split('.').pop(), cls.fqn, 'class', null, null, null,
          `class ${cls.fqn}  // from the classpath`, null, null,
        ).lastInsertRowid,
      );
      insertType.run(cls.fqn, typeId, 'class', '[]');
      stats.types++;

      for (const m of cls.members) {
        const { erased, arg } = splitGeneric(m.returns);
        insertSymbol.run(
          fileId, m.name, `${cls.fqn}#${m.name}`, 'method', cls.fqn, erased, arg,
          `${m.returns} ${m.name}(${(m.params ?? []).join(', ')})  // from the classpath`,
          m.arity, JSON.stringify(m.params ?? []),
        );
        stats.members++;
      }
    }
  }
  return stats;
}
