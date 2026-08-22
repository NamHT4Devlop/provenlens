/**
 * MyBatis: a `@Mapper` interface has no implementation in the source at all --
 * MyBatis builds a proxy at runtime from an XML file. This links the interface
 * method to the SQL statement that actually runs, and makes that SQL a symbol
 * so it can be read like any other code.
 *
 * Annotation-based mappers (`@Select` on the method) need no linking: the SQL
 * is already inside the method the resolver indexed.
 */

const STATEMENT = /<\s*(select|insert|update|delete)\b([^>]*)>/gi;
const ATTR = (name, text) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(text)?.[1];

/** Line number of a character offset, 1-based. */
function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

export default {
  name: 'mybatis',
  edgeKind: 'implemented-by',
  confidence: 0.95,

  accepts: (rel) => /\.xml$/i.test(rel) && !/pom\.xml$/i.test(rel),

  collect(ctx) {
    const namespaces = new Map(); // namespace -> [{ key, symbolId }]

    for (const file of ctx.files) {
      const namespace = ATTR('namespace', /<\s*mapper\b[^>]*>/i.exec(file.content)?.[0] ?? '');
      if (!namespace) continue; // not a MyBatis mapper

      for (const match of file.content.matchAll(STATEMENT)) {
        const [tag, verb, attrs] = [match[0], match[1], match[2]];
        const id = ATTR('id', attrs);
        if (!id) continue;

        const start = match.index;
        const closing = new RegExp(`</\\s*${verb}\\s*>`, 'i');
        const rest = file.content.slice(start);
        const endMatch = closing.exec(rest);
        const end = start + (endMatch ? endMatch.index + endMatch[0].length : tag.length);

        const key = `${namespace}#${id}`;
        const symbolId = ctx.addSymbol({
          fileId: file.id,
          name: id,
          // Prefixed: the Java method already owns `namespace#id`, and two
          // symbols sharing an FQN makes both unaddressable by name.
          fqn: `sql:${key}`,
          kind: 'sql-statement',
          containerFqn: namespace,
          signature: `<${verb.toLowerCase()} id="${id}">`,
          startLine: lineAt(file.content, start),
          endLine: lineAt(file.content, end),
          startByte: start,
          endByte: end,
          annotations: [verb.toLowerCase()],
        });

        ctx.emit({ role: 'provider', key, symbolId, fileId: file.id, line: lineAt(file.content, start) });
        if (!namespaces.has(namespace)) namespaces.set(namespace, []);
        namespaces.get(namespace).push(key);
      }
    }

    if (!namespaces.size) return;

    // Only methods on a type that an XML file claims as its namespace can be
    // mapper methods, which keeps this from touching unrelated interfaces.
    const placeholders = [...namespaces.keys()].map(() => '?').join(', ');
    const methods = ctx.db
      .prepare(
        `SELECT s.id, s.name, s.container_fqn, s.file_id, s.start_line
           FROM symbols s
          WHERE s.kind = 'method' AND s.container_fqn IN (${placeholders})`,
      )
      .all(...namespaces.keys());

    for (const m of methods) {
      ctx.emit({
        role: 'consumer',
        key: `${m.container_fqn}#${m.name}`,
        symbolId: m.id,
        fileId: m.file_id,
        line: m.start_line,
      });
    }
  },
};
