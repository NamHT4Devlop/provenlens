# codelens

Code knowledge graph cá nhân cho **Java, Ruby, TypeScript, JavaScript** — cộng một tầng
**string binding** để nối những chỗ mà đồ thị lời gọi không thể thấy (Camel, MyBatis, SQS, Flyway).

## TL;DR

Đánh chỉ mục codebase sẵn thành đồ thị (symbol + ai gọi ai) lưu trong SQLite, để AI agent hỏi
**một câu** là nhận đủ: source thật có đánh số dòng, ai gọi hàm này, hàm này gọi ai, sửa nó thì
vỡ chỗ nào — thay vì grep/đọc file hàng chục lượt.

Chạy 100% offline, không gọi API nào, **không cần compile** — `node:sqlite` có sẵn trong Node 22+,
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
| Java | ✅ | ✅ | Spring DI xuyên interface, chọn overload theo **kiểu tham số**, `this.field`, tham số lambda |
| Ruby | ✅ | ✅ | **Quy ước Rails**: `belongs_to`/`has_many`/`attr_*`/`scope` sinh method ảo có kiểu; mixin `include` |
| TypeScript / TSX | ✅ | ✅ | **Module resolution thật**: tsconfig `paths`, barrel file, `export *`; parameter property; suy luận kiểu trả về |
| JavaScript | ✅ | ✅ | Chung đồ thị module với TS |
| XML, SQL | — | — | Không có grammar, nhưng **được plugin binding đọc** (MyBatis mapper, Flyway migration) |

## Framework bindings

Một số framework nối hai mảnh code bằng **chuỗi ký tự**, không phải bằng lời gọi. Không đồ thị
lời gọi nào thấy được. Plugin khai báo hai đầu, một pass chung khớp chúng lại:

| Plugin | Nối gì | Cạnh sinh ra |
|---|---|---|
| `mybatis` | Method của `@Mapper` interface ↔ `<select id="...">` trong XML | `implemented-by` (0.95) |
| `camel` | `from("direct:x")` ↔ `.to("direct:x")` | `routes-to` (0.9) |
| `sqs` | Producer ↔ `@SqsListener` / Shoryuken worker, **xuyên ngôn ngữ** | `sends-to` (0.85) |
| `flyway` | `V*__*.sql` ↔ entity/mapper đụng tới bảng đó | `touches-table` (0.6) |

Câu SQL trong XML và mỗi file migration **trở thành symbol thật** — `codelens explore
"OrderMapper#findById"` trả về cả chữ ký Java lẫn câu SQL sẽ chạy.

Camel còn bắt tay SQS: route gửi vào `aws2-sqs:order-events` nối thẳng tới `@SqsListener` và tới
worker Ruby nghe cùng queue đó.

**Thêm framework mới** = thêm một file trong `src/bindings/` khai báo `accepts` (file cần đọc) và
`collect` (phát ra provider/consumer kèm `key`). Phần khớp và sinh cạnh là dùng chung.

## Đọc con số cho đúng

Trong một app Spring thật, **46–59% lời gọi là gọi vào class nằm trong JAR**. Gộp chúng vào
"unresolved" khiến chỉ số vô nghĩa. codelens tách ba nhóm:

```
calls = linked + library + missed
```

- **linked** — đã nối được thành cạnh
- **library** — chứng minh được là nằm ngoài cây index (JAR, gem, node_modules). Không phải lỗi.
- **missed** — chỗ resolver thật sự hụt. **Chỉ nhóm này mới là bug.**

Chỉ số đáng nhìn là **in-repo resolution** = `linked / (calls − library)`.

Điều quan trọng: **không hard-code danh sách framework nào cả.** Bằng chứng nằm sẵn trong code —
`import` có FQN không nằm trong index thì chắc chắn là JAR; import trong TS không trỏ tới file nào
thì là `node_modules`; tổ tiên không được index thì method thiếu đến từ đó (`JpaRepository#findById`,
`RouteBuilder#from`, `ActionController::Base#render`). Cơ chế này tự đúng với mọi thư viện bạn thêm.

### Số đo trên repo thật

| Repo | Loại | In-repo resolution | Thư viện |
|---|---|---|---|
| spring-petclinic | Spring Boot + Data | 41.5% | 46.6% |
| spring-cloud-aws | 803 file Java | 37.7% | 49.7% |
| human-essentials | Rails, 1043 file | 38.9% | — |
| agenta | 3891 file TS/JS | 27.7% | 28.3% |
| mybatis jpetstore | MyBatis + Flyway | 29.6% | 57.4% |
| camel-spring-boot-examples | ~50 ví dụ Camel | 11.5% | 45.2% |

Camel thấp là **trung thực**: repo đó là ~50 project độc lập, trung bình 6 file, gần như chỉ gọi
DSL Camel — vốn không có đồ thị nội bộ để tìm. Đo bằng `./scripts/bench.js <repo> --detail`.

## Lệnh

| Lệnh | Việc |
|---|---|
| `codelens init [path]` | Tạo `.codelens/` và build index lần đầu |
| `codelens sync [-w]` | Parse lại file đã đổi; `-w` tự động theo dõi |
| `codelens index` | Build lại toàn bộ |
| `codelens status` | Độ phủ, chất lượng resolve, số binding |
| `codelens query <tên>` | Tìm symbol theo tên |
| `codelens explore <tên>` | Source + call path + binding + blast radius, một lần |
| `codelens node <tên>` | Một symbol đầy đủ + caller/callee |
| `codelens impact <tên>` | Blast radius |
| `codelens install [target]` | Đăng ký MCP vào agent (`--dry-run` xem trước) |
| `codelens mcp [path]` | MCP server qua stdio |

## Gắn vào Claude Code

```bash
codelens install claude-user
```

In thay đổi trước khi ghi, luôn giữ `.bak`. Hoặc thủ công:

```bash
claude mcp add codelens -- node /Users/MAC/AI-TOOL/codelens/bin/codelens.js mcp
```

Ba tool: `codelens_explore`, `codelens_impact`, `codelens_status`. Mỗi tool nhận `projectPath` nên
**một server dùng chung mọi repo**. Index tự cập nhật bằng file watcher.

## Kiến trúc

```
src/lang.js              nạp grammar WASM (web-tree-sitter)
src/project.js           duyệt file, tôn trọng .gitignore
src/extract/{java,ruby,typescript}.js   AST → symbol / import / local / call site
src/resolve/{java,ruby,typescript}.js   call site → định nghĩa thật   ← khó nhất
src/bindings/index.js    khung plugin + khớp provider/consumer
src/bindings/{mybatis,camel,sqs,flyway}.js
src/indexer.js           extract → SQLite → resolve → bindings
src/query.js             tra cứu, callers/callees, blast radius
src/format.js            payload text cho agent
src/watch.js             auto-sync
src/mcp.js               JSON-RPC stdio, tự viết, không thêm dependency
scripts/ast.js           dump AST — để viết extractor mới
scripts/bench.js         đo chất lượng trên repo thật
```

### Độ tin cậy của cạnh

Mỗi cạnh mang `confidence` + ghi chú `via` giải thích cách suy ra, để cạnh sai truy ngược được:

| conf. | via | Nghĩa |
|---|---|---|
| 1.0 | `direct` | Biết kiểu receiver, tìm thấy method trên kiểu đó hoặc lớp cha |
| 0.95 | `binding:mybatis` | Method mapper ↔ câu SQL cùng id |
| 0.9 | `interface->impl` | Receiver là interface → nối tới bản cài đặt |
| 0.9 | `binding:camel` | Cùng URI endpoint |
| 0.85 | `binding:sqs` | Cùng tên queue |
| 0.8 | `rails-association` | Kiểu suy ra từ reader do `belongs_to`/`has_many` sinh |
| 0.7 | `self-chain`, `module->includer` | Qua chuỗi tổ tiên / mixin |
| 0.6 | `binding:flyway` | Khớp bảng ↔ entity theo **quy ước đặt tên** |
| 0.5 / 0.4 | `unique-name` | Không có thông tin kiểu, đúng một method trùng tên (Ruby thấp hơn) |

Symbol do plugin sinh ra (câu SQL, route, migration) được đánh dấu `generated` và `explore` ghi rõ
*"derived, not written in this file"*.

### Vì sao duyệt AST thủ công thay vì tree-sitter query

Query string vỡ **âm thầm** khi grammar đổi version — vẫn chạy, chỉ trả 0 match. Duyệt tay dài hơn
nhưng sai ở đâu lộ ở đó. Dùng `scripts/ast.js <file>` để xem cây thật.

### Version bị ghim

`web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`. Runtime 0.26 **không đọc được** grammar
0.1.13 (lỗi ABI khi `Language.load`).

### Schema đổi thì index tự dựng lại

Index là cache. Tăng `SCHEMA_VERSION` trong `src/db.js` là index cũ bị xoá và dựng lại.

## Test

```bash
npm test
```

70 test trên 5 bộ fixture:

| Fixture | Mô phỏng | Chuỗi mà grep không lần ra |
|---|---|---|
| `java` | Spring: Controller → interface Service → Impl → interface Repository | DI xuyên 2 lớp interface + overload cùng arity |
| `ruby` | Rails: model, concern, service object, controller | `donor.name` — `donor` do `belongs_to` sinh, `name` do `attr_reader` sinh |
| `ts` | TS + JS: barrel file, tsconfig alias, DI qua constructor | import qua `export *` rồi mới tới class thật |
| `bindings` | MyBatis + Camel + SQS + Flyway | Java producer → Ruby Shoryuken worker qua tên queue |
| toàn bộ `__fixtures__` | Một repo chứa cả 4 ngôn ngữ | Resolver không xoá đè đồ thị của nhau |

Test khẳng định fixture Java và Ruby **không còn miss nào**; phần còn lại đều được quy về đúng thư
viện. Nếu resolver sau này hụt một call nội bộ, test đỏ ngay.

## Hạn chế đã biết

- **Chuỗi fluent** vẫn là nhóm miss lớn nhất. Kiểu được lan truyền qua chuỗi khi mọi mắt xích nằm
  trong repo; chạm vào kiểu thư viện là dừng.
- **JS thuần không có type annotation** → không suy được kiểu receiver. Báo là miss, không đoán bừa.
- **SQS xuyên repo**: chỉ nối được hai đầu nếu cùng nằm trong repo đang index. Cần index nhiều repo
  cùng lúc mới trace được luồng xuyên microservice.
- **Inflector Ruby** đơn giản, không xử lý bất quy tắc (`people`/`person`).
- **MyBatis dạng annotation** (`@Select` trên method) không cần binding — SQL đã nằm sẵn trong method.

## Việc còn lại

- [ ] Chỉ mục nhiều repo để trace luồng xuyên microservice
- [ ] Ruby: `delegate`, `method_missing`, concern `included do`
- [ ] TS: generic, decorator (NestJS/Angular DI)
- [ ] Đọc `.d.ts` trong `node_modules` để resolve API thư viện
