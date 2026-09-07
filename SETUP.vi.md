# Cài đặt provenlens, từng bước

*English version: [SETUP.md](SETUP.md).* Bản tiếng Anh là bản gốc; bản này dịch theo nó.

Đây là tài liệu để đọc nếu bạn chưa từng dùng provenlens và muốn nó chạy trên máy mình. Mỗi bước
nói rõ gõ gì, phải thấy gì, và làm gì khi không thấy. Không cần trình biên dịch, không cần database
server, không cần tài khoản, và sau khi cài thì không cần mạng. Khoảng mười phút trên một laptop
bình thường.

Cuối cùng bạn có: một lệnh `provenlens` dựng call graph cho bất kỳ repo Java, Ruby, TypeScript hay
JavaScript nào và trả lời *ai gọi hàm này, hàm này gọi gì, sửa nó thì hỏng gì, test nào đã phủ nó*.
Nếu bạn dùng Claude Code, agent sẽ tự lấy những câu trả lời đó.

---

## Bước 1 -- Kiểm tra máy có gì

Mở terminal và chạy:

```bash
node -v
```

**Phải thấy** `v22.x.x` hoặc cao hơn (`v24.13.0` là bản dùng để viết tài liệu này).

**Nếu không:** provenlens cần Node 22 trở lên vì nó dùng `node:sqlite`, thứ chỉ có từ Node 22. Cài
bản LTS hiện tại từ <https://nodejs.org>, hoặc nếu dùng nvm thì `nvm install 22`. Bản cũ hơn sẽ
lỗi ngay lệnh đầu với `Cannot find module 'node:sqlite'`.

```bash
yarn --version
```

**Phải thấy** `1.22.x`. Project này dùng Yarn 1 (Classic).

**Nếu không:**

```bash
npm install -g yarn
```

```bash
git --version
```

**Phải thấy** một phiên bản bất kỳ. provenlens hỏi git xem file nào thuộc repo, nên git phải có;
gần như máy nào cũng có sẵn.

Tùy chọn, chỉ cần cho repo Java:

```bash
javap -version
```

**Phải thấy** phiên bản JDK (ở đây là `21.0.2`). javap cho provenlens đọc JDK và các jar phụ
thuộc, biến "tôi đoán đây là lời gọi thư viện" thành "đây là `java.io.PrintStream`". Không có nó
mọi thứ vẫn chạy, chỉ là câu trả lời cho Java kém chắc hơn. JDK 11 trở lên đều có.

---

## Bước 2 -- Lấy code và cài bốn dependency

```bash
git clone https://github.com/NamHT4Devlop/provenlens.git ~/provenlens
```

```bash
cd ~/provenlens && yarn install
```

**Phải thấy** yarn kết thúc bằng `Done in Ns.` và không có lỗi. Nó cài đúng bốn gói: `commander`,
`ignore`, `web-tree-sitter`, `tree-sitter-wasms`, và không có gì bên dưới chúng. Mỗi gói ghim đúng
phiên bản; lockfile đã commit, nên bạn nhận đúng những byte mà các benchmark trong README đã đo.

**Nếu** yarn cảnh báo về phiên bản Node, đọc lại Bước 1. **Nếu** nó dừng ở `web-tree-sitter`,
đừng nâng cấp nó: bản 0.26 và 0.27 không load được grammar đi kèm (xem *Pinned versions* trong
README). `yarn install --frozen-lockfile` khôi phục đúng cặp đã ghim.

Bạn có thể đặt clone ở đâu cũng được. Phần còn lại giả định `~/provenlens`; thay bằng đường dẫn
của bạn nếu chọn chỗ khác.

---

## Bước 3 -- Biến `provenlens` thành một lệnh

**macOS và Linux:**

```bash
mkdir -p ~/.local/bin && ln -sf ~/provenlens/bin/provenlens.js ~/.local/bin/provenlens
```

```bash
provenlens --version
```

**Phải thấy** `0.1.0`.

**Nếu thấy** `command not found`: `~/.local/bin` chưa nằm trong PATH. Thêm vào rồi mở lại
terminal (hoặc `source` file):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

(Dùng `~/.bashrc` nếu shell của bạn là bash.) Vì sao dùng symlink chứ không `npm link` hay `yarn
link`: hai lệnh đó cài vào thư mục bin của đúng phiên bản Node đang chạy, nên đổi phiên bản Node là
lệnh biến mất không báo. Symlink vào `~/.local/bin` sống qua việc đó.

**Nếu thấy** dòng kiểu `ExperimentalWarning: SQLite is an experimental feature`: bạn đã chạy
trực tiếp `node ~/provenlens/bin/provenlens.js`. Qua symlink thì cảnh báo được tắt; nếu buộc phải
gọi node, thêm `--no-warnings`.

**Windows:** không có bước symlink. Hoặc chạy mọi lệnh dạng
`node C:\path\to\provenlens\bin\provenlens.js ...`, hoặc tạo file `provenlens.cmd` ở một thư mục
trong PATH với nội dung đúng như sau:

```
@node --no-warnings "C:\path\to\provenlens\bin\provenlens.js" %*
```

---

## Bước 4 -- Giữ index ngoài mọi repo, làm một lần

provenlens ghi index vào thư mục `.provenlens/` ở gốc mỗi repo bạn index. Đó là cache: xóa an
toàn, dựng lại khi cần, và không bao giờ được commit, nhất là vào repo của team. Bảo git bỏ qua nó ở
mọi nơi, một lần:

```bash
echo '.provenlens/' >> "$(git config --global core.excludesfile || echo ~/.config/git/ignore)"
```

Kiểm tra đã ăn:

```bash
cd /đường/dẫn/một/repo/git && git check-ignore -v .provenlens/
```

**Phải thấy** một dòng nêu tên file excludes toàn cục của bạn và mẫu `.provenlens/`.

**Nếu không thấy gì:** git chưa cấu hình file excludes toàn cục, và lệnh `echo` ở trên đã ghi vào
`~/.config/git/ignore`, thứ git chỉ đọc khi `core.excludesfile` chưa đặt *và* đường dẫn đó tồn tại.
Khai báo rõ cho git:

```bash
git config --global core.excludesfile ~/.config/git/ignore
```

---

## Bước 5 -- Index repo đầu tiên

Vào một repo viết bằng Java, Ruby, TypeScript hoặc JavaScript và dựng index:

```bash
cd /đường/dẫn/repo && provenlens init .
```

**Phải thấy** đại loại như sau (một project Spring nhỏ):

```
created .provenlens/ in /đường/dẫn/repo
indexed 41 file(s), 312 symbol(s)
java: 421 direct, 38 via impl, 3 by name, 12 missed, 640 library (97.5% of in-repo calls linked)
http: 9 provider(s), 2 consumer(s), 2 wired
```

Dòng theo từng ngôn ngữ là bảng điểm của resolver: bao nhiêu lời gọi nối được tới khai báo trong
repo này (`direct`, `via impl`), bao nhiêu nối theo quy ước đặt tên (`by name`), bao nhiêu không đặt
được (`missed`), và bao nhiêu đi vào thư viện, thứ không tính là miss. Phần trăm chỉ đếm những lời
gọi *có thể* rơi vào repo này.

**Mất bao lâu:** vài trăm file mỗi giây. Project 2.000 file xong dưới mười giây; monolith 25.000
file khoảng một phút rưỡi. Lần đầu trên repo Java mất thêm một hai giây cho javap.

**Nếu thấy** `N file(s) refused as machine-packed`: đó là bundle minified hoặc file sinh tự động,
và từ chối chúng là đúng, vì chúng không phải source và sẽ thổi phồng mọi con số.

**Nếu thấy** một ngôn ngữ trong `discovered but not parsed`: đó là ngôn ngữ provenlens không hỗ trợ
(Python, Go, C#...). File của bốn ngôn ngữ được hỗ trợ vẫn được index.

---

## Bước 6 -- Xem index đáng giá bao nhiêu

```bash
provenlens status
```

**Phải thấy** các con số và một dòng quan trọng nhất:

```
resolution: 93.4% of the calls that could be in this repo
```

Đọc con số đó trước khi tin bất cứ điều gì khác. Trên 90% với Java hoặc TypeScript là bình thường;
Ruby và JavaScript thuần thấp hơn vì hai ngôn ngữ này không khai báo kiểu, và mục *Reading the
numbers honestly* trong README nói chính xác nên kỳ vọng gì và vì sao.

```bash
provenlens doctor
```

**Phải thấy** danh sách phát hiện, mỗi cái có `why` và `fix`, rồi bảng đếm những miss còn lại là
gì. `[MISSING]` nghĩa là một dependency chưa cài và cài nó sẽ nâng con số; `[INHERENT]` nghĩa là
giới hạn nằm ở chính ngôn ngữ, cài gì cũng không đổi. Cách sửa hay gặp nhất chỉ là cài dependency
của chính project:

```bash
npm install
```

với project JavaScript hoặc TypeScript (`pnpm install` / `yarn install` tùy project), hoặc một
lần build tải jar với Java (`mvn dependency:resolve`, `./gradlew dependencies`). Rồi:

```bash
provenlens index
```

để dựng lại, và `provenlens status` lần nữa. Con số là đo được, không bao giờ là dự đoán; có repo
cài đủ mọi thứ vẫn không đổi gì, và `doctor` sẽ nói vậy.

---

## Bước 7 -- Hỏi nó

Lệnh duy nhất cần nhớ:

```bash
provenlens explore "TenClassHoacMethod"
```

**Phải thấy** source thật của các symbol khớp với số dòng, rồi với mỗi cái: *Callers*, *Calls out
to*, wiring của framework nếu có, và blast radius. Dưới *Callers* có thể có một mục tên **Unlinked
call sites named `x`**: những lời gọi trùng tên mà graph không nối được tới đâu, có file và dòng.
Đó là chỗ để đọc, không phải caller; graph không bao giờ đoán, và danh sách này là cách để không
cần đoán.

Các câu hỏi hẹp hơn:

```bash
provenlens callers "Type#method"
```

```bash
provenlens impact "Type#method"
```

```bash
provenlens affected src/some/file.rb
```

`callers` là ai gọi nó. `impact` là mọi thứ chạm tới nó theo chuỗi. `affected` nhận các file đã
đổi, hoặc `git diff --name-only | provenlens affected`, và trả lời test nào đã phủ thay đổi đó. Nếu
một tên khớp nhiều symbol, lệnh dừng và liệt kê; chạy lại với cách viết `Type#method` nó chỉ ra.

Hai lệnh nữa nên biết: `provenlens why "Type#method"` nói link nào của một symbol dựa trên khai
báo và link nào dựa trên quy ước, còn `provenlens dead` liệt kê method không ai chạm tới, được xây
để chỉ sai theo hướng an toàn. Danh sách đầy đủ ở mục *Commands* trong README.

---

## Bước 8 -- Giữ index mới

Index phản ánh lần dựng cuối. Sau khi sửa code, cập nhật:

```bash
provenlens sync
```

Chỉ file có nội dung thay đổi được đọc lại. Để việc đó tự chạy trong lúc bạn làm việc:

```bash
provenlens sync -w
```

để một watcher chạy trong terminal đó. Khi provenlens được nâng cấp và schema đổi, lệnh kế tiếp
trong repo đó dừng lại với `index was built by an older version and has been reset. Run provenlens
index.`; chạy lệnh đó và index được dựng lại từ đầu.

---

## Bước 9 -- Nối vào Claude Code (tùy chọn, nhưng là mục đích chính)

Xem trước nó sẽ ghi gì, chưa ghi:

```bash
provenlens install claude-user --hooks --dry-run
```

**Phải thấy** hai thứ nó sẽ đổi: mục MCP server trong `~/.claude.json`, và hai hook trong
`~/.claude/settings.json`. Rồi làm thật:

```bash
provenlens install claude-user --hooks
```

Nó để lại file `.bak` cạnh mỗi file đã sửa. Khởi động lại Claude Code (hoặc mở phiên mới).

**Bạn có gì bây giờ.** Năm tool MCP `provenlens_explore`, `provenlens_impact`,
`provenlens_affected`, `provenlens_why`, `provenlens_status` mà Claude gọi được trong bất kỳ repo
nào có index `.provenlens/`. Và hai hook: đầu mỗi phiên trong repo đã index, một đoạn báo Claude
rằng index có ở đó; sau mỗi `Edit` hay `Write`, Claude thấy file đó chạm tới gì và test nào phủ nó,
không cần hỏi.

**Kiểm tra chạy:** mở Claude Code trong một repo đã index ở Bước 5 và hỏi *"ai gọi X?"* với một
method bạn biết. Câu trả lời phải dẫn `provenlens_explore`, không phải grep. Sửa một file bất kỳ đã
index và bạn phải thấy một dòng bắt đầu bằng `provenlens · path/to/file:` trong trả lời.

**Một việc nữa tự viết.** Agent dùng tool khi được bảo. Thêm đoạn dưới mục *Using it from Claude
Code* trong README vào `CLAUDE.md` của bạn (toàn cục hoặc theo repo): nó bảo Claude lấy graph trước
grep, kiểm `provenlens_status` một lần, nói ra khi phải quay về grep, và coi mục *Unlinked call
sites* là chỗ cần đọc chứ không phải caller.

`provenlens install cursor` làm nửa MCP cho Cursor. `provenlens install claude-project` ghi
`.mcp.json` vào thư mục hiện tại thay vì home; nó không bao giờ tự động, nên file cấu hình không
thể lọt vào repo team do sơ ý.

---

## Bước 10 -- Tùy chọn: giao diện web

```bash
provenlens serve -o
```

**Phải thấy** một địa chỉ local cổng 7777 kèm `?token=...` in ra một lần, và trình duyệt mở lên.
Nó chỉ phục vụ `127.0.0.1`. Truyền nhiều đường dẫn repo, hoặc một thư mục chứa nhiều repo, để duyệt
chung. `-p 7800` nếu cổng bị chiếm.

---

## Cập nhật provenlens

```bash
cd ~/provenlens && git pull && yarn install --frozen-lockfile
```

`--frozen-lockfile` từ chối dịch các phiên bản đã ghim; nếu nó lỗi thì lockfile và `package.json`
không khớp, và việc an toàn là đọc lý do trước khi ép. Nếu bản nâng cấp đổi schema của index, lệnh
kế tiếp trong mỗi repo đã index sẽ yêu cầu chạy `provenlens index`; chạy một lần cho mỗi repo.

---

## Gỡ cài đặt

Lấy lại những gì Bước 9 đã ghi (in thay đổi trước; `--dry-run` để chỉ in):

```bash
provenlens uninstall
```

Xóa index của một repo:

```bash
provenlens uninit /đường/dẫn/repo
```

Rồi xóa `~/provenlens` và symlink. Không có gì khác được ghi ở đâu cả.

---

## Khi có gì đó sai

| Bạn thấy | Nghĩa là | Làm thế này |
|---|---|---|
| `command not found: provenlens` | Thiếu symlink hoặc `~/.local/bin` không trong PATH | Bước 3; `ls -l ~/.local/bin/provenlens` và `echo $PATH` cho biết cái nào |
| `Cannot find module 'node:sqlite'` | Node cũ hơn 22 | Bước 1 |
| `no .provenlens/ found here, in any parent, or one level down` | Repo này chưa từng được index | `cd` vào, `provenlens init .` |
| `another provenlens index is running on this project (pid N)` | Một `sync -w`, một `serve` hoặc phiên Claude đang giữ lock của index | Đợi, hoặc dừng tiến trình đó |
| `index was built by an older version and has been reset. Run provenlens index.` | Bạn đã nâng cấp provenlens và schema đổi | `provenlens index` trong repo đó |
| Lỗi `Language.load` hoặc ABI | `web-tree-sitter` lệch khỏi 0.25.10 | `cd ~/provenlens && yarn install --frozen-lockfile` |
| `resolution:` thấp hơn hẳn số README nêu cho ngôn ngữ đó | Chưa cài dependency, hoặc repo chủ yếu là Ruby/JS không kiểu | `provenlens doctor` nói là cái nào |
| `EADDRINUSE` từ `serve` | Cổng 7777 bị chiếm | `provenlens serve -p 7800` |
| Claude không bao giờ dùng tool | MCP chưa đăng ký, hoặc phiên mở trước khi install | `provenlens install claude-user --dry-run`; khởi động lại Claude Code; thêm đoạn `CLAUDE.md` |

Nếu không có dòng nào khớp, `provenlens doctor` và `provenlens status` là hai output đáng dán vào
issue.
