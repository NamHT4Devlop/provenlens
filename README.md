# codelens

Code knowledge graph cá nhân cho **Java, Ruby, TypeScript, JavaScript** — cộng một tầng
**string binding** để nối những chỗ mà đồ thị lời gọi không thể thấy (Camel, MyBatis, SQS, Flyway).

## TL;DR

Đánh chỉ mục codebase sẵn thành đồ thị (symbol + ai gọi ai) lưu trong SQLite, để AI agent hỏi
**một câu** là nhận đủ: source thật có đánh số dòng, ai gọi hàm này, hàm này gọi ai, sửa nó thì
vỡ chỗ nào — thay vì grep/đọc file hàng chục lượt.

Chạy 100% offline, không gọi API nào, **không cần compile** — `node:sqlite` có sẵn trong Node 22+,
grammar là WASM.

### Cài

```bash
npm install
```

```bash
ln -sf "$PWD/bin/codelens.js" ~/.local/bin/codelens
```

Dùng symlink thay vì `npm link`: `npm link` gắn vào thư mục riêng của phiên bản Node hiện tại
(`~/.nvm/versions/node/vXX/bin`), nên đổi phiên bản Node là lệnh biến mất. Gỡ cài đặt chỉ là
`rm ~/.local/bin/codelens`.

### Dùng

Mỗi repo phải `init` một lần trước — mọi lệnh khác đều cần index:

```bash
cd /đường/dẫn/tới/repo && codelens init .
```

```bash
codelens explore "DonationService"
```

```bash
codelens serve --open
```

## Ngôn ngữ

| | Extractor | Resolver | Điểm mạnh riêng |
|---|---|---|---|
| Java | ✅ | ✅ | Spring DI xuyên interface, chọn overload theo **kiểu tham số**, `this.field`, tham số lambda |
| Ruby | ✅ | ✅ | **Quy ước Rails**: `belongs_to`/`has_many`/`attr_*`/`scope` sinh method ảo có kiểu; mixin `include`; **RSpec** `let`/`subject`/`described_class` được gán kiểu nên spec nối được vào code nó test |
| TypeScript / TSX | ✅ | ✅ | **Module resolution thật**: tsconfig `paths`, barrel file, `export *`; parameter property; suy luận kiểu trả về |
| JavaScript | ✅ | ✅ | Chung đồ thị module với TS |
| XML, SQL | — | — | Không có grammar, nhưng **được plugin binding đọc** (MyBatis mapper, Flyway migration) |
| `db/schema.rb` | — | — | Cột database → thuộc tính ActiveRecord. `account.uri` chạy được là nhờ có cột, và schema là **nơi duy nhất** trong source ghi lại điều đó |

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
| agenta | TS/JS, 3891 file | **85.0%** | 52.3% |
| nest | TS, 1817 file | **84.2%** | 75.1% |
| mybatis spring-boot-starter | MyBatis | **81.3%** | 81.3% |
| rubygems.org | Rails, 1338 file | **79.7%** | 77.2% |
| spring-cloud-aws | Java, 803 file | **77.7%** | 76.8% |
| human-essentials | Rails, 994 file | **77.7%** | 76.4% |
| express | JS thuần, 141 file | **77.4%** | 52.4% |
| halo | Java 1349 + TS 862 | **77.0%** | 73.3% |
| mastodon | Rails 3258 + TS 734 | **74.5%** | 72.3% |

Cột cuối là điều kiện tự kiểm: giả sử **mọi** phán đoán runtime đều sai thì còn lại bao nhiêu.

**Lưu ý về hai repo Rails:** con số của human-essentials và rubygems.org *giảm* khi bật đọc
`db/schema.rb`, và đó là điều đúng. Trước đó `created_at`/`name` không có khai báo nào trong
source nên được **chứng minh là ngoài project** — một chứng minh sai, vì chúng có thật dưới dạng
thuộc tính ActiveRecord. Giờ chúng nằm trong index, mẫu số lớn hơn, và đồ thị đầy đủ hơn ~10%
(riêng human-essentials có 676 cạnh mới trỏ vào cột DB). Số thấp hơn nhưng trung thực hơn.

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
| `codelens serve [paths...] [-p 7777] [-o]` | **Web UI** — search và duyệt đồ thị, một hoặc **nhiều repo** cùng lúc |
| `codelens mcp [path]` | MCP server qua stdio |

`query`, `callers`, `callees`, `impact`, `affected` đều nhận `--json` để nối vào tool khác.

### Web UI

```bash
codelens serve --open
```

**Nhiều repo cùng lúc.** Trỏ vào thư mục chứa nhiều service, nó tự tìm mọi repo đã `init` bên trong:

```bash
codelens serve ~/work/services --open
```

Hoặc liệt kê thẳng: `codelens serve ./order-service ./notify-service`.

Thanh trên có chip chọn repo — **không chọn gì thì hiện tất cả**, chọn một repo thì thu hẹp vào
repo đó. Mỗi repo một màu, vẽ thành **vòng ngoài node** nên không đè lên màu theo loại symbol.

**Cạnh xuyên repo.** Đây mới là lý do mở nhiều repo: producer SQS ở service này và listener ở
service kia chỉ dính nhau qua **tên queue**, không có lời gọi nào. codelens khớp các endpoint
binding giữa các index và vẽ chúng thành **đường xanh ngọc nét đứt, có nhãn tên queue**:

```
order-service:publishOrder  ──sqs: order-events──▶  notify-service:onOrder     (Java)
                            └─sqs: order-events──▶  audit-service:OrderAuditWorker  (Ruby)
```

Xuyên repo **và** xuyên ngôn ngữ. Symbol được đánh địa chỉ theo `repo:id` vì mỗi index đánh số
riêng từ 1 — ID trần sẽ đụng nhau ngay khi mở repo thứ hai.

Một trang tự chứa, không build step, không dependency ngoài: gõ để tìm symbol, chọn để xem source
thật kèm số dòng, rồi **bấm vào bất kỳ liên kết nào để đi tiếp trong đồ thị** — caller, callee,
quan hệ kiểu, liên kết framework, blast radius. Symbol suy ra (reader của `belongs_to`, cột DB,
câu SQL trong XML) được gắn nhãn `derived`; file test gắn nhãn `test`. Phím `/` để về ô tìm kiếm,
mũi tên lên/xuống để duyệt.

Server **chỉ nghe trên `127.0.0.1`, chỉ đọc**, và tự cập nhật index bằng file watcher.

Ba lớp chặn, mỗi lớp có test hồi quy trong `test/server.test.js`:

- **Token khi khởi động** (kiểu Jupyter) — in kèm URL, so khớp `timingSafeEqual`. Chặn process
  khác trên cùng máy đọc index. `--open` xử lý tự động; trang tự gỡ token khỏi thanh địa chỉ sau
  khi tải để nó không lọt vào history.
- **Kiểm tra `Host`** — chặn DNS rebinding, tức trang web độc trỏ DNS về `127.0.0.1` để đọc API
  của bạn. Loopback thôi là chưa đủ cho ca này.
- **Không có CORS header** — trang cross-origin gửi được request nhưng không đọc được response.

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

127 test trên 5 bộ fixture cộng hồi quy, bảo mật và multi-repo:

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
- **SQS xuyên repo**: đã hỗ trợ — `codelens serve <workspace>` khớp endpoint giữa các index.
  Riêng CLI vẫn làm việc trên một repo tại một thời điểm.
- **Inflector Ruby** đơn giản, không xử lý bất quy tắc (`people`/`person`).
- **MyBatis dạng annotation** (`@Select` trên method) không cần binding — SQL đã nằm sẵn trong method.

## Việc còn lại

- [ ] Đưa multi-repo xuống CLI và MCP (hiện mới có ở web UI)
- [ ] Ruby: `delegate`, `method_missing`, concern `included do`
- [ ] TS: generic, decorator (NestJS/Angular DI)
- [ ] Đọc `.d.ts` trong `node_modules` để resolve API thư viện
