/**
 * gRPC: a .proto declares a service and its methods, a server class implements
 * the generated base, and a client calls a stub. None of it is a call the graph
 * can follow -- the generated code that would join the two ends is not in the
 * repository at all.
 *
 * The coordinate is `Service/method`, which is what the wire uses and what both
 * ends therefore agree on.
 *
 * The implementation is the provider; the .proto declaration and any stub call
 * point at it.
 */

const PROTO_FILE = /\.proto$/i;

/** `service OrderService {` -- the body is read to its matching brace below. */
const SERVICE_OPEN = /\bservice\s+([A-Za-z_]\w*)\s*\{/g;

/**
 * Each service with its whole body. A non-greedy match to the first `}` cut a
 * service off at the first rpc carrying an option body -- grpc-gateway's
 * `option (google.api.http) = { ... }` -- and every rpc after it vanished.
 */
function serviceBlocks(text) {
  const out = [];
  for (const open of text.matchAll(SERVICE_OPEN)) {
    const start = open.index + open[0].length;
    let depth = 1;
    let i = start;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    out.push({ service: open[1], bodyStart: start, body: text.slice(start, i - 1) });
  }
  return out;
}
/** `rpc GetOrder (Req) returns (Res);` */
const RPC_LINE = /\brpc\s+([A-Za-z_]\w*)\s*\(/g;

/**
 * The service a generated Java base class belongs to.
 *
 * grpc-java generates `OrderServiceGrpc.OrderServiceImplBase`, and both halves
 * name the service. Anything else is some other base class.
 */
export function serviceFromBase(superName, imports = []) {
  if (!superName || typeof superName !== 'string') return null;
  const name = superName.trim();
  const qualified = /^([A-Za-z_]\w*)Grpc\.\1ImplBase$/.exec(name);
  if (qualified) return qualified[1];
  // `import ...OrderServiceGrpc.OrderServiceImplBase;` then `extends
  // OrderServiceImplBase` -- the usual way it is written. The bare half
  // names the service only when the import says the generated class is where
  // it came from; `FooImplBase` from anywhere else is some other base.
  const bare = /^([A-Za-z_]\w*)ImplBase$/.exec(name);
  if (!bare) return null;
  const fromGrpc = imports.some((fqn) => fqn.endsWith(`.${bare[1]}Grpc.${bare[1]}ImplBase`));
  return fromGrpc ? bare[1] : null;
}

/** `Service/method`, lowercasing nothing: the wire is case-sensitive. */
export function rpcCoordinate(service, method) {
  if (!service || !method) return null;
  if (!/^[A-Za-z_]\w*$/.test(service) || !/^[A-Za-z_]\w*$/.test(method)) return null;
  return `${service}/${method}`;
}

/**
 * A .proto names methods in PascalCase and every generated server renames them:
 * Java and TypeScript lower the first letter, Go and C# do not. Matching on the
 * proto spelling alone would join nothing, so both are tried.
 */
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

export default {
  name: 'grpc',
  edgeKind: 'implemented-by',
  confidence: 0.9,
  accepts: (rel) => PROTO_FILE.test(rel),

  collect(ctx) {
    /** proto spelling -> the coordinate it declared, for the rename below. */
    const declared = new Map();

    // --- The .proto: each rpc becomes a symbol and asks for an implementation
    for (const file of ctx.files) {
      for (const { service, bodyStart, body } of serviceBlocks(file.content)) {
        for (const rpc of body.matchAll(RPC_LINE)) {
          const key = rpcCoordinate(service, rpc[1]);
          if (!key) continue;
          const at = bodyStart + rpc.index;
          const symbolId = ctx.addSymbol({
            fileId: file.id,
            name: rpc[1],
            // Prefixed for the reason mybatis prefixes statements: the server
            // method owns this name already.
            fqn: `rpc:${key}`,
            kind: 'rpc-method',
            containerFqn: service,
            signature: `rpc ${rpc[1]}`,
            startLine: file.lineAt(at),
            endLine: file.lineAt(at),
            startByte: at,
            endByte: at + rpc[0].length,
            annotations: ['proto'],
          });
          declared.set(rpcCoordinate(service, lowerFirst(rpc[1])), key);
          ctx.emit({
            role: 'consumer',
            key,
            symbolId,
            fileId: file.id,
            line: file.lineAt(at),
            detail: `rpc ${rpc[1]}`,
          });
        }
      }
    }

    // --- Java: a class extending the generated base implements the service ---
    const types = ctx.db
      .prepare(
        `SELECT t.fqn, t.supertypes, s.file_id FROM types t JOIN symbols s ON s.id = t.symbol_id
          WHERE t.supertypes IS NOT NULL AND t.supertypes != '[]'`,
      )
      .all();

    const importsOf = ctx.db.prepare('SELECT fqn FROM imports WHERE file_id = ?');
    for (const type of types) {
      let supers = [];
      try {
        supers = JSON.parse(type.supertypes || '[]');
      } catch {
        continue;
      }
      const imports = importsOf.all(type.file_id).map((r) => r.fqn);
      const service = supers.map((sup) => serviceFromBase(sup, imports)).find(Boolean);
      if (!service) continue;

      const methods = ctx.db
        .prepare(
          `SELECT id, name, file_id, start_line FROM symbols
            WHERE container_fqn = ? AND kind = 'method'`,
        )
        .all(type.fqn);

      for (const method of methods) {
        // The generated base lowers the proto's first letter, so `GetOrder`
        // becomes `getOrder`. Emit under whichever spelling the proto used --
        // and under the method's own when no proto was read, so a repository
        // holding only the server still records its endpoints.
        const key = declared.get(rpcCoordinate(service, method.name))
          ?? rpcCoordinate(service, method.name);
        if (!key) continue;
        ctx.emit({
          role: 'provider',
          key,
          symbolId: method.id,
          fileId: method.file_id,
          line: method.start_line,
          detail: `${service}ImplBase#${method.name}`,
        });
      }
    }
  },
};
