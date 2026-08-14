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

## Trạng thái

| Ngôn ngữ | Extractor | Resolver | Ghi chú |
|---|---|---|---|
| Java | ✅ | ✅ | Kể cả kế thừa và Spring DI xuyên interface |
| Ruby | ⏳ | ⏳ | Grammar đã có, chưa viết extractor |
| TypeScript | ⏳ | ⏳ | Cần mô phỏng tsconfig paths + barrel file |
| JavaScript | ⏳ | ⏳ | Không có type → sẽ dựa vào tên + scope |

File thuộc ngôn ngữ chưa làm vẫn được **đếm** và báo trong `codelens status` là *no extractor yet*,
không im lặng bỏ qua.

## Lệnh

| Lệnh | Việc |
|---|---|
| `codelens init [path]` | Tạo `.codelens/` và build index lần đầu |
| `codelens sync` | Chỉ parse lại file đã đổi nội dung (so hash) |
| `codelens index` | Build lại toàn bộ từ đầu |
| `codelens status` | Độ phủ index + tỉ lệ resolve được |
| `codelens query <tên>` | Tìm symbol theo tên |
| `codelens explore <tên>` | Source + call path + blast radius trong 1 lần |
| `codelens node <tên>` | Một symbol đầy đủ + caller/callee |
| `codelens impact <tên>` | Blast radius: mọi thứ chạm tới symbol này |
| `codelens mcp [path]` | Chạy MCP server qua stdio |

## Gắn vào Claude Code

```bash
claude mcp add codelens -- node /Users/MAC/AI-TOOL/codelens/bin/codelens.js mcp
```

Server expose 3 tool: `codelens_explore`, `codelens_impact`, `codelens_status`. Mỗi tool nhận
`projectPath` để hỏi bất kỳ repo nào đã `init`, nên một server dùng chung cho mọi project.
Server tự `sync` lại nếu index cũ hơn 30 giây.

## Kiến trúc

```
src/lang.js          nạp grammar WASM (web-tree-sitter)
src/project.js       tìm root, duyệt file, tôn trọng .gitignore
src/extract/java.js  duyệt AST → symbol / import / local / call site thô
src/resolve/java.js  nối call site ↔ định nghĩa thật  ← phần khó nhất
src/indexer.js       ghép extract → SQLite → resolve
src/query.js         tra cứu, callers/callees, blast radius
src/format.js        dựng payload text cho agent
src/mcp.js           JSON-RPC stdio, tự viết, không thêm dependency
```

### Vì sao duyệt AST thủ công thay vì tree-sitter query

Query string vỡ **âm thầm** khi grammar đổi version — vẫn chạy, chỉ là trả về 0 match. Duyệt tay
dài dòng hơn nhưng sai ở đâu là lộ ra ở đó.

### Độ tin cậy của cạnh

Mỗi cạnh mang một `confidence` và một ghi chú `via` giải thích cách suy ra, để một cạnh sai truy
ngược được thay vì bị tin mù quáng:

| confidence | via | Nghĩa |
|---|---|---|
| 1.0 | `direct` | Biết kiểu receiver, tìm thấy method trên kiểu đó hoặc lớp cha |
| 0.9 | `interface->impl` | Receiver là interface → nối tới các bản cài đặt (ca Spring điển hình) |
| 0.5 | `unique-name` | Không có thông tin kiểu, nhưng đúng một method mang tên đó |

### Version bị ghim

`web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`. Bản 0.26 của runtime **không đọc được**
grammar 0.1.13 (lỗi ABI khi `Language.load`). Nâng runtime thì phải kiểm tra lại cặp này.

## Test

```bash
npm test
```

Fixture `__fixtures__/java/` là một app Spring thu nhỏ (Controller → interface Service → Impl →
interface Repository → Impl) — cố tình dựng đúng chuỗi mà grep không lần ra được. Test khẳng định
`impact DonationRepository#findAll` phải chạm tới `DonationController#list`, và những call site
còn lại chưa resolve **chỉ được phép** là JDK bên ngoài.

## Việc còn lại

- [ ] Extractor Ruby (+ lớp quy ước Rails: `has_many`, `belongs_to` sinh method vô hình)
- [ ] Extractor TypeScript (tsconfig paths, barrel file, `export *`)
- [ ] Extractor JavaScript
- [ ] Xử lý overload Java bằng kiểu tham số, không chỉ số lượng tham số
- [ ] Auto-sync bằng file watcher thay cho ngưỡng 30 giây
- [ ] `codelens install` tự ghi cấu hình MCP vào agent
