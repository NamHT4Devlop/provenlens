# codelens

Code knowledge graph cá nhân cho **Java, Ruby, TypeScript, JavaScript**.

## TL;DR

Đánh chỉ mục codebase sẵn thành một đồ thị (symbol + ai gọi ai) lưu trong SQLite, để AI agent
hỏi **một câu** là nhận đủ: source thật có đánh số dòng, ai gọi hàm này, hàm này gọi ai, và sửa
nó thì vỡ chỗ nào — thay vì grep/đọc file hàng chục lượt.

Chạy 100% offline. Không gọi API nào. Không cần compile — `node:sqlite` có sẵn trong Node 22+,
grammar là WASM.

```bash
npm install && npm link
```

```bash
codelens init /đường/dẫn/tới/repo
```

```bash
codelens explore "DonationService"
```

## Ngôn ngữ

| | Extractor | Resolver | Điểm mạnh riêng |
|---|---|---|---|
| Java | ✅ | ✅ | Kế thừa, Spring DI xuyên interface, **chọn overload theo kiểu tham số** |
| Ruby | ✅ | ✅ | **Quy ước Rails**: `belongs_to`/`has_many`/`attr_*`/`scope` sinh method ảo có kiểu; mixin `include` |
| TypeScript / TSX | ✅ | ✅ | **Module resolution thật**: tsconfig `paths`, barrel file, `export *`; parameter property; suy luận kiểu trả về |
| JavaScript | ✅ | ✅ | Dùng chung đồ thị module với TS (TS import được JS và ngược lại) |

## Lệnh

| Lệnh | Việc |
|---|---|
| `codelens init [path]` | Tạo `.codelens/` và build index lần đầu |
| `codelens sync [-w]` | Parse lại file đã đổi; `-w` để tự động theo dõi thay đổi |
| `codelens index` | Build lại toàn bộ từ đầu |
| `codelens status` | Độ phủ index + tỉ lệ resolve được |
| `codelens query <tên>` | Tìm symbol theo tên |
| `codelens explore <tên>` | Source + call path + blast radius trong 1 lần |
| `codelens node <tên>` | Một symbol đầy đủ + caller/callee |
| `codelens impact <tên>` | Blast radius: mọi thứ chạm tới symbol này |
| `codelens install [target]` | Đăng ký MCP server vào agent (`--dry-run` để xem trước) |
| `codelens mcp [path]` | Chạy MCP server qua stdio |

## Gắn vào Claude Code

```bash
codelens install claude-user
```

Lệnh này in ra thay đổi trước khi ghi và luôn giữ bản `.bak`. Hoặc làm thủ công:

```bash
claude mcp add codelens -- node /Users/MAC/AI-TOOL/codelens/bin/codelens.js mcp
```

Server expose 3 tool: `codelens_explore`, `codelens_impact`, `codelens_status`. Mỗi tool nhận
`projectPath` để hỏi bất kỳ repo nào đã `init`, nên **một server dùng chung cho mọi project**.
Index tự cập nhật bằng file watcher.

## Kiến trúc

```
src/lang.js             nạp grammar WASM (web-tree-sitter)
src/project.js          tìm root, duyệt file, tôn trọng .gitignore
src/extract/java.js     ─┐
src/extract/ruby.js      ├─ duyệt AST → symbol / import / local / call site thô
src/extract/typescript.js┘   (một file phục vụ cả .ts .tsx .js)
src/resolve/java.js     ─┐
src/resolve/ruby.js      ├─ nối call site ↔ định nghĩa thật   ← phần khó nhất
src/resolve/typescript.js┘
src/indexer.js          ghép extract → SQLite → resolve
src/query.js            tra cứu, callers/callees, blast radius
src/format.js           dựng payload text cho agent
src/watch.js            auto-sync (fs.watch, fallback polling trên Linux)
src/install.js          ghi cấu hình MCP vào agent
src/mcp.js              JSON-RPC stdio, tự viết, không thêm dependency
scripts/ast.js          dump AST — công cụ để viết extractor mới
```

Thêm một ngôn ngữ = thêm `extract/<lang>.js` + `resolve/<lang>.js` + 1 dòng đăng ký ở mỗi
`index.js`. File thuộc ngôn ngữ chưa hỗ trợ vẫn được **đếm** và `codelens status` báo rõ
*"no extractor yet"*, không im lặng bỏ qua.

### Độ tin cậy của cạnh

Mỗi cạnh mang một `confidence` và một ghi chú `via` giải thích cách suy ra, để cạnh sai truy
ngược được thay vì bị tin mù quáng:

| conf. | via | Ngôn ngữ | Nghĩa |
|---|---|---|---|
| 1.0 | `direct` | tất cả | Biết kiểu receiver, tìm thấy method trên kiểu đó hoặc lớp cha |
| 0.9 | `interface->impl` | Java, TS | Receiver là interface → nối tới bản cài đặt (ca Spring/DI điển hình) |
| 0.8 | `rails-association` | Ruby | Receiver có kiểu nhờ reader do `belongs_to`/`has_many` sinh ra |
| 0.7 | `self-chain` | Ruby | Gọi ngầm qua `self`, tìm thấy trên class/superclass/mixin |
| 0.7 | `module->includer` | Ruby | Method của module → các class `include` nó |
| 0.5 | `unique-name` | Java, TS | Không có thông tin kiểu, nhưng đúng một method mang tên đó |
| 0.4 | `unique-name` | Ruby | Như trên, hạ thấp hơn vì Ruby trùng tên nhiều hơn hẳn |

Method do DSL sinh ra (Rails) được gắn `modifiers: ['generated']` + annotation là macro sinh ra
nó, để không ai nhầm là code có thật trên đĩa.

### Vì sao duyệt AST thủ công thay vì tree-sitter query

Query string vỡ **âm thầm** khi grammar đổi version — vẫn chạy, chỉ là trả về 0 match. Duyệt tay
dài dòng hơn nhưng sai ở đâu là lộ ra ở đó. Dùng `scripts/ast.js <file>` để xem cây thật.

### Version bị ghim

`web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`. Bản 0.26 của runtime **không đọc được**
grammar 0.1.13 (lỗi ABI khi `Language.load`). Nâng runtime thì phải kiểm tra lại cặp này.

### Schema đổi thì index tự dựng lại

Index là cache, không phải dữ liệu gốc. `SCHEMA_VERSION` trong `src/db.js` tăng lên là index cũ
bị xoá và dựng lại, thay vì migrate.

## Test

```bash
npm test
```

46 test trên 4 bộ fixture:

| Fixture | Mô phỏng | Chuỗi mà grep không lần ra |
|---|---|---|
| `__fixtures__/java` | Spring: Controller → interface Service → Impl → interface Repository | DI xuyên 2 lớp interface + overload cùng arity |
| `__fixtures__/ruby` | Rails: model, concern, service object, controller | `donor.name` — `donor` do `belongs_to` sinh, `name` do `attr_reader` sinh |
| `__fixtures__/ts` | TS + JS: barrel file, tsconfig alias, DI qua constructor | import qua barrel `export *` rồi mới tới class thật |
| toàn bộ `__fixtures__` | Một repo chứa cả 4 ngôn ngữ | Resolver không được xoá đè đồ thị của nhau |

Test khẳng định những call site **còn lại chưa resolve chỉ được phép là API ngoài project**
(JDK, Rails framework, built-in của JS). Nếu sau này resolver hụt một call nội bộ, test đỏ ngay.

## Việc còn lại

- [ ] Java: Camel route (`from`/`to` nối bằng string URI), MyBatis mapper → XML statement
- [ ] Ruby/Java: nối producer ↔ consumer SQS theo tên queue
- [ ] Ruby: `delegate`, `method_missing`, concern `included do`
- [ ] TS: generic, `keyof`/mapped type, decorator (NestJS/Angular DI)
- [ ] Chỉ mục nhiều repo để trace luồng xuyên microservice
