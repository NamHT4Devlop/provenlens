/**
 * GraphQL: a schema declares a field, a resolver implements it, and nothing
 * calls anything.
 *
 * This is the shape mybatis has -- a declaration in one file, an implementation
 * in another, joined by a name -- so the schema field becomes a real symbol the
 * way an SQL statement does. `provenlens explore "Query.orders"` then returns
 * the schema line and the method that answers it.
 *
 * The resolver is the provider: the schema field points at whatever runs.
 */

const SCHEMA_FILE = /\.(graphqls?|gql)$/i;

/** Spring GraphQL. The field is the method name unless the annotation says otherwise. */
const SPRING_ROOTS = { QueryMapping: 'Query', MutationMapping: 'Mutation', SubscriptionMapping: 'Subscription' };
/** NestJS type-graphql, the same three plus a field resolver. */
const NEST_ROOTS = { Query: 'Query', Mutation: 'Mutation', Subscription: 'Subscription' };

/** `type Query { ... }` and the fields inside a block, without a real parser. */
const TYPE_BLOCK = /\b(?:type|extend\s+type|interface)\s+([A-Za-z_]\w*)[^{]*\{([^}]*)\}/g;
/** A field line: `orders(first: Int): [Order!]!`, minus directives and comments. */
const FIELD_LINE = /^\s*([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/;
/** NestJS names the field in an object: `@Query(() => [Order], { name: 'orders' })`. */
const NEST_NAME = /\bname\s*:\s*['"`]([^'"`]+)['"`]/;

/** `Query.orders` -- a schema coordinate, which is what both ends share. */
export function coordinate(typeName, field) {
  if (!typeName || !field) return null;
  if (!/^[A-Za-z_]\w*$/.test(typeName) || !/^[A-Za-z_]\w*$/.test(field)) return null;
  return `${typeName}.${field}`;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

export default {
  name: 'graphql',
  edgeKind: 'implemented-by',
  confidence: 0.9,
  accepts: (rel) => SCHEMA_FILE.test(rel),

  collect(ctx) {
    // --- The schema: every field becomes a symbol, and asks for a resolver --
    for (const file of ctx.files) {
      for (const block of file.content.matchAll(TYPE_BLOCK)) {
        const typeName = block[1];
        const body = block[2];
        const bodyStart = block.index + block[0].indexOf('{') + 1;

        let offset = 0;
        for (const line of body.split('\n')) {
          const at = bodyStart + offset;
          offset += line.length + 1;
          const clean = line.replace(/#.*$/, '');
          const match = FIELD_LINE.exec(clean);
          if (!match) continue;
          const key = coordinate(typeName, match[1]);
          if (!key) continue;

          const symbolId = ctx.addSymbol({
            fileId: file.id,
            name: match[1],
            // Prefixed for the same reason mybatis prefixes its statements: the
            // resolver method may already own this name, and two symbols with
            // one FQN leaves both unaddressable.
            fqn: `graphql:${key}`,
            kind: 'graphql-field',
            containerFqn: typeName,
            signature: clean.trim(),
            startLine: lineAt(file.content, at),
            endLine: lineAt(file.content, at),
            startByte: at,
            endByte: at + line.length,
            annotations: ['schema'],
          });
          ctx.emit({
            role: 'consumer',
            key,
            symbolId,
            fileId: file.id,
            line: lineAt(file.content, at),
            detail: clean.trim(),
          });
        }
      }
    }

    // --- Spring GraphQL: the annotation, and the method name as the default -
    const annotated = ctx.db
      .prepare(
        `SELECT id, name, file_id, annotations, start_line
           FROM symbols
          WHERE kind = 'method' AND annotations IS NOT NULL AND annotations != '[]'`,
      )
      .all();

    // The annotation's own arguments, by the line it sits on: str_args keeps
    // the values and drops the attribute names, so `@SchemaMapping(typeName =
    // "Order", field = "customer")` arrives as two anonymous strings.
    const argsAt = new Map();
    for (const ref of ctx.refs("r.kind = 'annotation' AND r.str_args IS NOT NULL")) {
      argsAt.set(`${ref.file_id}:${ref.line}:${ref.name.replace(/^@/, '')}`, ref.strArgs);
    }

    for (const method of annotated) {
      let names = [];
      try {
        names = JSON.parse(method.annotations || '[]').map((a) => String(a).replace(/^@/, ''));
      } catch {
        continue;
      }

      for (const annotation of names) {
        const args = argsAt.get(`${method.file_id}:${method.start_line}:${annotation}`) ?? [];
        let key = null;

        if (SPRING_ROOTS[annotation]) {
          // @QueryMapping           -> Query.<method name>
          // @QueryMapping("byId")   -> Query.byId
          key = coordinate(SPRING_ROOTS[annotation], args.find(Boolean) ?? method.name);
        } else if (annotation === 'SchemaMapping') {
          // typeName and field, in source order. With only two strings and no
          // attribute names, order is all there is -- and when just one is
          // given it is the field, on a type the class declares elsewhere.
          key = args.length >= 2 ? coordinate(args[0], args[1]) : null;
        } else if (NEST_ROOTS[annotation]) {
          key = coordinate(NEST_ROOTS[annotation], nestFieldName(ctx, method, annotation) ?? method.name);
        }
        // @ResolveField('customer') names a field and not the type it belongs
        // to -- that lives in the class's own @ObjectType, which this does not
        // read. A coordinate needs both halves, so these are left out rather
        // than matched on a bare field name that several types may share.

        if (!key) continue;
        ctx.emit({
          role: 'provider',
          key,
          symbolId: method.id,
          fileId: method.file_id,
          line: method.start_line,
          detail: `@${annotation} -> ${key}`,
        });
      }
    }
  },
};

/**
 * NestJS writes the field name inside an options object -- `@Query(() =>
 * [Order], { name: 'orders' })` -- which str_args never sees, so the decorator
 * line is read back from the file. Without it a resolver called `findAll`
 * would be recorded against `Query.findAll`, a field no schema declares.
 */
function nestFieldName(ctx, method, annotation) {
  const file = ctx.db.prepare('SELECT path FROM files WHERE id = ?').get(method.file_id);
  if (!file) return null;
  try {
    const lines = ctx.readSource(file.path).split('\n');
    // The decorator sits on the line before the method, sometimes two.
    const window = lines.slice(Math.max(0, method.start_line - 3), method.start_line).join(' ');
    if (!window.includes(`@${annotation}`)) return null;
    return NEST_NAME.exec(window)?.[1] ?? null;
  } catch {
    return null;
  }
}
