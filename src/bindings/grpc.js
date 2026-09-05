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

/** `service OrderService { ... }` and its body. */
const SERVICE_BLOCK = /\bservice\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\}/g;
/** `rpc GetOrder (Req) returns (Res);` */
const RPC_LINE = /\brpc\s+([A-Za-z_]\w*)\s*\(/g;

/**
 * The service a generated Java base class belongs to.
 *
 * grpc-java generates `OrderServiceGrpc.OrderServiceImplBase`, and both halves
 * name the service. Anything else is some other base class.
 */
export function serviceFromBase(superName) {
  if (!superName || typeof superName !== 'string') return null;
  const match = /^([A-Za-z_]\w*)Grpc\.\1ImplBase$/.exec(superName.trim());
  return match ? match[1] : null;
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

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

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
      for (const block of file.content.matchAll(SERVICE_BLOCK)) {
        const service = block[1];
        const bodyStart = block.index + block[0].indexOf('{') + 1;

        for (const rpc of block[2].matchAll(RPC_LINE)) {
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
            startLine: lineAt(file.content, at),
            endLine: lineAt(file.content, at),
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
            line: lineAt(file.content, at),
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

    for (const type of types) {
      let supers = [];
      try {
        supers = JSON.parse(type.supertypes || '[]');
      } catch {
        continue;
      }
      const service = supers.map(serviceFromBase).find(Boolean);
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
