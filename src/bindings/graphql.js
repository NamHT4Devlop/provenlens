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

import { attributeStrings } from './text.js';

/**
 * A schema with its descriptions blanked and its argument lists flattened,
 * offsets preserved, so a field can be read one line at a time.
 *
 * `"""Returns: a page"""` is a description, and read as a line it looked
 * like a field called `Returns`. An argument list spread over several lines
 * -- `orders(\n first: Int\n after: String\n): [Order!]!` -- made `first` and
 * `after` fields and lost `orders`, the only real one.
 */
function readable(text) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/"""[\s\S]*?"""/g, blank)
    .replace(/\([^()]*\)/g, (m) => m.replace(/\n/g, ' '));
}

export default {
  name: 'graphql',
  edgeKind: 'implemented-by',
  confidence: 0.9,
  accepts: (rel) => SCHEMA_FILE.test(rel),

  collect(ctx) {
    // --- The schema: every field becomes a symbol, and asks for a resolver --
    for (const file of ctx.files) {
      const content = readable(file.content);
      for (const block of content.matchAll(TYPE_BLOCK)) {
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
            startLine: file.lineAt(at),
            endLine: file.lineAt(at),
            startByte: at,
            endByte: at + line.length,
            annotations: ['schema'],
          });
          ctx.emit({
            role: 'consumer',
            key,
            symbolId,
            fileId: file.id,
            line: file.lineAt(at),
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

    // The annotation's own arguments, by the method it sits on. Keyed by line
    // they were lost whenever another annotation came first: the method's
    // start line is the first annotation's, and `@Deprecated` above
    // `@QueryMapping("orderById")` left the override unread.
    const argsOn = new Map();
    for (const ref of ctx.refs("r.kind = 'annotation' AND r.from_symbol_id IS NOT NULL")) {
      argsOn.set(`${ref.from_symbol_id}:${ref.name.replace(/^@/, '')}`, ref);
    }

    for (const method of annotated) {
      let names = [];
      try {
        names = JSON.parse(method.annotations || '[]').map((a) => String(a).replace(/^@/, ''));
      } catch {
        continue;
      }

      for (const annotation of names) {
        const ref = argsOn.get(`${method.id}:${annotation}`);
        const args = ref?.strArgs ?? [];
        let key = null;

        if (SPRING_ROOTS[annotation]) {
          // @QueryMapping           -> Query.<method name>
          // @QueryMapping("byId")   -> Query.byId
          const [named] = ref?.raw != null ? attributeStrings(ref.raw, ['value', 'name', 'field']) : args;
          key = coordinate(SPRING_ROOTS[annotation], named ?? method.name);
        } else if (annotation === 'SchemaMapping') {
          // typeName and field by name, whichever order they were written in:
          // read positionally, `field = "customer", typeName = "Order"` became
          // the coordinate `customer.Order`. A lone field belongs to a type
          // the class declares elsewhere, and is left alone.
          const typeName = ref?.raw != null ? attributeStrings(ref.raw, ['typeName'])[0] : args[0];
          const field = ref?.raw != null ? attributeStrings(ref.raw, ['field', 'value'])[0] : args[1];
          key = coordinate(typeName, field);
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
