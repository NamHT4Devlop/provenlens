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
- **library** — nằm ngoài cây index (JAR, gem, node_modules, runtime). Không phải lỗi.
- **missed** — chỗ resolver thật sự hụt. **Chỉ nhóm này mới là bug.**

Chỉ số đáng nhìn là **in-repo resolution** = `linked / (calls − library)`.

### Bốn loại bằng chứng, xếp theo độ chắc

Nhóm `library` **không phải một khối đồng nhất**, nên `bench` tách rõ để bạn tự kiểm toán:

| Bằng chứng | Loại | Cơ sở |
|---|---|---|
| Named library | **Chứng minh** | `import` có FQN không nằm trong index → chắc chắn là JAR; import TS không trỏ tới file nào → `node_modules` |
| Inherited | **Chứng minh** | Tổ tiên không được index thì method thiếu đến từ đó (`JpaRepository#findById`, `RouteBuilder#from`, `ActionController::Base#render`) |
| Name declared nowhere | **Chứng minh** | Không symbol nào trong index mang tên đó → lời gọi **không thể** trỏ vào repo. Trên petclinic: `assertThat` gọi 68 lần, `andExpect` 77 lần, khai báo trong repo: **0** |
| Runtime built-in | **Giả định** | `.map` trên receiver không suy được kiểu gần như chắc chắn là `Array.map`. Không có import để lần, không có tổ tiên để đi — cùng loại với `Kernel` của Ruby |

Bốn loại đầu là chứng minh. Loại cuối là suy luận mạnh, nên nó **mang nhãn owner riêng**
(`js-runtime`, `jdk-runtime`, `Kernel`) và `bench` in luôn con số *"nếu mọi giả định đều sai"* —
tức cận dưới tuyệt đối.

**Không hard-code danh sách framework nào cả.** Bốn luật đầu suy ra từ chính source, nên tự đúng
với mọi thư viện bạn thêm mà không cần cập nhật gì.

Và luật chứng minh **luôn chạy trước** luật giả định: nếu chứng minh được thì không đoán.

### Số đo trên repo thật

| Repo | Stack | In-repo resolution | Cận dưới nếu mọi giả định sai |
|---|---|---|---|
| spring-petclinic | Spring Boot + Data | **99.4%** | 98.6% |
| mall | Spring Boot + MyBatis, 524 file | **94.5%** | 94.5% |
| camel-spring-boot-examples | ~50 ví dụ Camel | **91.1%** | 90.1% |
| mybatis jpetstore | MyBatis + Flyway | **89.1%** | 89.1% |
| human-essentials | Rails, 994 file | **84.1%** | 82.6% |
| rubygems.org | Rails, 1338 file | **83.4%** | 80.5% |
| mybatis spring-boot-starter | MyBatis | **81.1%** | 81.1% |
| express | JS thuần, 141 file | **79.1%** | 49.7% |
| agenta | TS/JS, 3891 file | **78.6%** | 43.4% |
| spring-cloud-aws | Java, 803 file | **77.3%** | 76.4% |
| nest | TS, 1817 file | **75.2%** | 65.7% |
| halo | Java 1349 + TS 862 | **74.7%** | 70.7% |
| mastodon | Rails 3258 + TS 734 | **72.7%** | 69.7% |

Cột cuối là điều kiện tự kiểm: giả sử **mọi** phán đoán runtime đều sai thì còn lại bao nhiêu.
Java và Ruby gần như toàn bộ dựa trên chứng minh (chênh 1–4%); JS/TS dựa vào giả định nhiều nhất
vì không có kiểu để lần.

Phần còn hụt ở các repo dưới 90% là **giới hạn suy luận thật**, không phải lỗi phân loại:

- **mastodon, human-essentials** — RSpec `let(:x) { ... }` và `subject { ... }` tạo biến trong
  block; muốn suy kiểu phải mô hình hoá block.
- **halo, spring-cloud-aws** — chuỗi builder fluent của SDK ngoài.
- **nest, agenta** — TS generic, kiểu trả về suy từ tham số kiểu (`atom<T>`, hook).

Đo lại bất cứ lúc nào bằng `./scripts/bench.js <repo> --detail`.

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
| `codelens callers <tên>` / `callees <tên>` | Một chiều quan hệ |
| `codelens impact <tên>` | Blast radius |
| `codelens affected [files...]` | File đã đổi chạm tới cái gì + **test nào đã phủ** |
| `codelens install [target]` | Đăng ký MCP vào agent (`--dry-run` xem trước) |
| `codelens uninit [path]` | Xoá index khỏi project |
| `codelens mcp [path]` | MCP server qua stdio |

`query`, `callers`, `callees`, `impact`, `affected` đều nhận `--json` để nối vào tool khác.

### Luồng dùng hàng ngày

```bash
git diff --name-only | codelens affected
```

Trả về: symbol nào đã đổi, cái gì chạm tới chúng, và **những test sẵn có đang phủ** — tức là
danh sách test cần chạy lại. Trên spring-petclinic, sửa `Owner.java` cho ra 18 test liên quan.

## Gắn vào Claude Code

```bash
codelens install claude-user
```

In thay đổi trước khi ghi, luôn giữ `.bak`. Hoặc thủ công:

```bash
claude mcp add codelens -- node /Users/MAC/AI-TOOL/codelens/bin/codelens.js mcp
```

Bốn tool: `codelens_explore`, `codelens_impact`, `codelens_affected`, `codelens_status`. Mỗi tool
nhận `projectPath` nên **một server dùng chung mọi repo**. Index tự cập nhật bằng file watcher.

`codelens install` chỉ tự nhận diện agent đã có sẵn file cấu hình. Bản project-scope
(`.mcp.json` trong thư mục hiện tại) **không bao giờ tự động** — phải gọi tên rõ ràng, để không
vô tình thả file cấu hình vào repo team.

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

Fallback `unique-name` **không được áp dụng** khi tên đó là built-in của runtime: nối `xs.map()`
vào một method `map` bất kỳ trong repo là bịa ra cạnh, không phải suy luận.

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

95 test trên 5 bộ fixture cộng một bộ hồi quy:

| Fixture | Mô phỏng | Chuỗi mà grep không lần ra |
|---|---|---|
| `java` | Spring: Controller → interface Service → Impl → interface Repository | DI xuyên 2 lớp interface + overload cùng arity |
| `ruby` | Rails: model, concern, service object, controller | `donor.name` — `donor` do `belongs_to` sinh, `name` do `attr_reader` sinh |
| `ts` | TS + JS: barrel file, tsconfig alias, DI qua constructor | import qua `export *` rồi mới tới class thật |
| `bindings` | MyBatis + Camel + SQS + Flyway | Java producer → Ruby Shoryuken worker qua tên queue |
| toàn bộ `__fixtures__` | Một repo chứa cả 4 ngôn ngữ | Resolver không xoá đè đồ thị của nhau |

`test/regressions.test.js` khoá lại từng bug đã sửa: ký tự đại diện LIKE, thứ tự chấm điểm,
gộp cạnh trùng, kế toán file khi sync, luật ignore của watcher, nhận diện test, và file rỗng /
sai cú pháp / có tiếng Việt + emoji.

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
