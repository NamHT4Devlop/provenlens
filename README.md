# codelens

A personal code knowledge graph for **Java, Ruby, TypeScript and JavaScript** — plus a
**string-binding** layer that connects the places a call graph structurally cannot see
(Camel, MyBatis, SQS, Flyway).

## TL;DR

codelens pre-indexes a codebase into a graph of symbols and who-calls-what, stored in SQLite, so
an AI agent can ask **one question** and get everything: the real source with line numbers, what
calls this, what this calls, and what breaks if you change it — instead of a dozen rounds of grep
and file reads.

It runs **100% offline**. No API calls, no telemetry, no network egress of any kind, and **nothing
to compile** — `node:sqlite` ships inside Node 22+, and the grammars are WASM.

---

## Setup

### 1. Requirements

| | Why |
|---|---|
| **Node.js 22 or newer** | codelens uses `node:sqlite`, which only exists from Node 22. Nothing else is needed — no compiler, no native modules, no database server. |
| **Yarn 1.22 (Classic)** | The package manager this project is set up for; `packageManager` in `package.json` pins it. |
| A shell on macOS or Linux | Windows works under WSL. |

Check what you have:

```bash
node -v && yarn --version
```

If Node prints anything below `v22`, upgrade it first — every other step will fail otherwise.
If yarn is missing:

```bash
npm install -g yarn
```

### 2. Get the code and install dependencies

```bash
git clone git@github.com:NamHT4Devlop/codelens.git ~/AI-TOOL/codelens
```

```bash
cd ~/AI-TOOL/codelens && yarn install
```

That pulls exactly four packages: `commander`, `ignore`, `web-tree-sitter` and
`tree-sitter-wasms`. Four is the whole tree — **they bring no transitive dependencies at all** —
and each is pinned to an exact version (no `^`, no `~`), so a fresh install today resolves to the
same bytes it resolved to when the benchmarks below were measured. `yarn audit` reports 0
vulnerabilities across all four.

### 3. Put `codelens` on your PATH

```bash
ln -sf ~/AI-TOOL/codelens/bin/codelens.js ~/.local/bin/codelens
```

Use a symlink rather than `yarn link` or `npm link`. Both install into the bin directory of *the
Node version you happen to be running* (`~/.nvm/versions/node/vXX/bin`), so switching Node versions
makes the command silently disappear. A symlink into `~/.local/bin` survives that.

If `~/.local/bin` is not already on your PATH, add it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

Verify:

```bash
codelens --version
```

### 4. Index your first repository

Every repository must be indexed once before any other command works:

```bash
cd /path/to/your/repo && codelens init .
```

You should see something like this — the last line is the resolver reporting how much of the call
graph it managed to connect:

```
created .codelens/ in /path/to/your/repo
indexed 2 file(s), 6 symbol(s)
java: 1 direct, 0 via impl, 0 by name, 0 missed, 0 library (100.0% of in-repo calls linked)
```

The index lives in `.codelens/` at the repo root. It is a **cache** — safe to delete, rebuilt on
demand, and it should never be committed. Add `.codelens/` to your global gitignore so it can
never land in a team repository:

```bash
echo '.codelens/' >> "$(git config --global core.excludesfile || echo ~/.config/git/ignore)"
```

That appends to whichever file git is actually configured to read; `git config --global
core.excludesfile` on its own tells you which one that is.

### 5. Ask it something

```bash
codelens explore "OwnerController"
```

`explore` is the one command worth remembering — it returns the real source with line numbers, the
call paths in and out, framework bindings, and the blast radius, all in a single response:

````
# codelens explore: "OwnerController"

12 matches, showing 3. Others: ...OwnerController#findOwner, ...OwnerController#processCreationForm

## Match 1/3 — class org.springframework.samples.petclinic.owner.OwnerController @Controller
src/main/java/org/springframework/samples/petclinic/owner/OwnerController.java:48-179

```java
 48 | @Controller
 49 | class OwnerController {
 50 |
 51 | 	private static final String VIEWS_OWNER_CREATE_OR_UPDATE_FORM = "owners/createOrUpdateOwnerForm";
```
````

The narrower questions have their own commands:

```bash
codelens callers "wrap"
```

```
# Callers of demo.Formatter#wrap
src/Formatter.java:3

### Callers (1)
- demo.Greeter#greet — src/Greeter.java:5 [direct]
```

### 6. Keep the index fresh

The index does not update itself unless you ask it to. Three options, cheapest first:

```bash
codelens sync
```

```bash
codelens sync -w
```

```bash
codelens index
```

`sync` reparses only the files whose contents changed, `-w` keeps watching in the background, and
`index` rebuilds everything from scratch. `codelens serve` and the MCP server each run a watcher of
their own, so if you use either of those you rarely need to sync by hand.

### 7. Check the index is healthy

```bash
codelens status
```

```
root:    /path/to/spring-petclinic
indexed: 2026-08-22T15:56:53.071Z
files:   51   symbols: 313   types: 49
edges:   329   call sites: 1602
calls:   355 linked, 1245 into libraries, 2 missed
resolution: 99.4% of the calls that could be in this repo
by language:
  java            49
  xml              2  (read by framework bindings)
```

`missed` is the only number that represents a defect — see
[Reading the numbers honestly](#reading-the-numbers-honestly) for why `library` is not one.

### 8. Optional — the web UI

```bash
codelens serve --open
```

It prints two URLs:

```
codelens UI on http://127.0.0.1:7777/?token=ecf03d237e77307bc12f255bea265623
bookmark:   http://127.0.0.1:7777/
```

Open the first one once. The page keeps the token, so from then on the short one is enough —
bookmark that. The token is stored under your state directory and reused on every restart, so the
bookmark keeps working tomorrow. `codelens serve --new-token` retires it if you ever want it gone.

### 9. Optional — wire it into Claude Code

```bash
codelens install claude-user
```

This prints the change before writing it and always leaves a `.bak`. See
[Using it from Claude Code](#using-it-from-claude-code) for the manual form and for what the four
MCP tools do.

### Uninstalling

```bash
codelens uninit /path/to/repo
```

```bash
rm ~/.local/bin/codelens
```

```bash
rm -rf ~/AI-TOOL/codelens
```

The first removes one repository's index, the second removes the command, the third removes
codelens itself.

### Troubleshooting setup

| Symptom | Cause and fix |
|---|---|
| `zsh: command not found: codelens` | The symlink is missing, or `~/.local/bin` is not on your PATH. Run `ls -l ~/.local/bin/codelens` and `echo $PATH` to see which. |
| `Cannot find module 'node:sqlite'` | Node is older than 22. Check `node -v`, then upgrade. |
| `no index — run: codelens init` | That repository has never been indexed. `cd` into it and run `codelens init .`. |
| A `Language.load` / ABI error on first run | Something upgraded `web-tree-sitter` past 0.25.10. Run `yarn install --frozen-lockfile` to restore the pinned versions — see [Pinned versions](#pinned-versions). |
| `EADDRINUSE` from `codelens serve` | Port 7777 is already taken, most likely by an earlier `serve`. Use `codelens serve -p 7800`, or stop the old one. |
| The web UI says it needs a token | This browser has not been given the token yet, or `--new-token` retired the one it had. Open the `?token=…` URL `serve` printed once; the bare address works from then on. |

---

## Languages

| | Extractor | Resolver | What it does well |
|---|---|---|---|
| Java | ✅ | ✅ | Spring DI across interfaces, overload selection **by parameter type**, nested types resolved through the enclosing scope; **Lombok** (`@Data`/`@Getter`/`@Setter`/`@Value`/`@Builder`/`@Accessors`) and **record accessors** generated the way the compiler writes them; **generics carried into lambdas** — from a declared `Mono<User>`, a `User.class` argument, or a `Consumer<X>` parameter |
| Ruby | ✅ | ✅ | **Rails conventions**: `belongs_to`/`has_many`/`attr_*`/`scope`/`delegate` produce typed virtual methods; `include` mixins and concern `included do` blocks; `method_missing` as a labelled last resort; **RSpec** `let`/`subject`/`described_class` are typed, so a spec connects to the code it tests |
| TypeScript / TSX | ✅ | ✅ | **Real module resolution**: tsconfig `paths`, barrel files, `export *`, and **CommonJS `require()`**; parameter properties; return types inferred from `return new X()` when unannotated; `await` unwraps `Promise<T>`; **decorators recorded like Java annotations** (so `@SqsMessageHandler` binds queues); `Array<T>` read as `T[]` and carried into callbacks |
| JavaScript | ✅ | ✅ | Shares the module graph with TypeScript |
| XML, SQL | — | — | No grammar, but **read by the binding plugins** (MyBatis mappers, Flyway migrations) |
| `db/schema.rb` | — | — | Database columns become ActiveRecord attributes. `account.uri` works because a column exists, and the schema file is the **only** place in the source that records it |

## Framework bindings

Some frameworks connect two pieces of code through **a string**, not a call. No call graph can see
that. A plugin declares both ends, and one shared pass matches them:

| Plugin | What it connects | Edge produced |
|---|---|---|
| `mybatis` | `@Mapper` interface method ↔ `<select id="...">` in XML | `implemented-by` (0.95) |
| `camel` | `from("direct:x")` ↔ `.to("direct:x")` | `routes-to` (0.9) |
| `sqs` | Producer ↔ `@SqsListener` / NestJS `@SqsMessageHandler` / Shoryuken worker, **across languages** | `sends-to` (0.85) |
| `flyway` | `V*__*.sql` ↔ the entity or mapper touching that table | `touches-table` (0.6) |

SQL statements in XML and each migration file **become real symbols** — `codelens explore
"OrderMapper#findById"` returns both the Java signature and the SQL that will actually run.

Camel and SQS shake hands too: a route publishing to `aws2-sqs:order-events` links straight through
to a `@SqsListener` and to a Ruby worker consuming the same queue.

**Adding a new framework** means adding one file to `src/bindings/` that declares `accepts` (which
files to read) and `collect` (emit providers and consumers with a shared `key`). The matching and
edge creation are shared.

## Reading the numbers honestly

In a real Spring application, **46–59% of all calls target a class inside a JAR**. Counting those
as "unresolved" makes the metric meaningless. codelens splits three ways:

```
calls = linked + library + missed
```

- **linked** — connected into an edge
- **library** — outside the indexed tree (JAR, gem, node_modules, runtime). Not a failure.
- **missed** — the resolver genuinely came up short. **Only this bucket is a bug.**

The number worth watching is **in-repo resolution** = `linked / (calls − library)`.

### Four kinds of evidence, strongest first

The `library` bucket is **not one homogeneous thing**, so `bench` breaks it out for you to audit:

| Evidence | Kind | Basis |
|---|---|---|
| Named library | **Proof** | An `import` whose FQN is not in the index is certainly a JAR; a TS import resolving to no file is `node_modules` |
| Inherited | **Proof** | If an ancestor is not indexed, the missing method comes from there (`JpaRepository#findById`, `RouteBuilder#from`, `ActionController::Base#render`) |
| Name declared nowhere | **Proof** | No symbol in the index carries that name, so the call **cannot** target this repo. In petclinic: `assertThat` called 68 times, `andExpect` 77 times, declarations in the repo: **0** |
| Runtime built-in | **Assumption** | `.map` on a receiver whose type cannot be inferred is almost certainly `Array.map`. No import to follow, no ancestor to walk — the same class of judgement as Ruby's `Kernel` |

The first three are proofs. The last is a strong inference, so it **carries its own owner label**
(`js-runtime`, `jdk-runtime`, `Kernel`) and `bench` also prints the *"if every assumption were
wrong"* figure — the absolute floor.

**No framework list is hardcoded anywhere.** The three proof rules are derived from the source
itself, so they stay correct for any library you add without an update here.

And proof **always runs before** assumption: if it can be proven, it is never guessed.

### Measured on real repositories

Seventeen repositories, none of them chosen for its score. The six added last were named in
advance — two self-contained Java, two Rails, two TypeScript — and four of them landed below the
median the other eleven had, which pulled it from 89.2% down to 88.1%. That is what picking before
measuring costs, and it is the only way the table means anything.

| Repo | Stack | In-repo resolution | Floor if every assumption were wrong |
|---|---|---|---|
| spring-petclinic | Spring Boot + Data, 51 files | **99.7%** | **98.6%** |
| mall | Spring Boot + MyBatis, 630 files | **98.9%** | **98.9%** |
| mybatis spring-boot-starter | MyBatis, 154 files | **98.7%** | **98.7%** |
| camel-spring-boot-examples | ~50 Camel examples, 325 files | **97.8%** | **97.3%** |
| mybatis jpetstore | MyBatis + Flyway, 43 files | **97.8%** | **97.8%** |
| TheAlgorithms/Java | plain Java, 1588 files | **94.7%** | **94.0%** |
| express | plain JS, 141 files | **91.4%** | **91.1%** |
| java-design-patterns | Java, 1991 files | **89.1%** | 86.8% |
| rubygems.org | Rails, 1392 files | **88.1%** | 80.4% |
| mastodon | Rails + TS, 4199 files | **87.4%** | 79.8% |
| spring-cloud-aws | Java, 816 files | **86.2%** | 84.7% |
| nest | TS, 1904 files | **85.7%** | 80.8% |
| halo | Java + TS, 2228 files | **85.4%** | 83.2% |
| solidus | Rails, 2329 files | **83.4%** | 74.7% |
| discourse | Rails, 14358 files | **78.3%** | 72.2% |
| typeorm | TS, 3575 files | **72.1%** | 65.6% |
| axios | JS, 217 files | **64.7%** | 54.2% |

**Seven of the seventeen clear 90% on both columns**, and which seven is the most useful thing the
table says. It does not sort by repository size or by language. It sorts by **who declares the
receiver's type**:

- Types declared *inside the repository* — Spring with Lombok, MyBatis, plain Java, a small
  self-contained JS package. Every one of these clears 90% on both numbers.
- Types declared by a **dependency** — Reactor in halo, the Spring test harness in
  spring-cloud-aws, TypeORM's own generics. The declarations are not on this machine at all: the
  clones have no `node_modules`, and there is no `~/.m2` or `~/.gradle`.
- Types declared **nowhere** — Ruby, and JavaScript callbacks. `axios` is the clearest case in the
  table: its tests are written as `startHTTPServer((req, res) => res.end(...))`, and nothing in
  JavaScript ever says what `res` is. 64.7% is the honest reading of that, not a defect.

**Two numbers, and the second is the one that keeps the first honest.** The floor assumes every
judgement the resolver made without a declaration behind it was wrong — both directions. Calls
excused as runtime built-ins come back into the denominator, *and* every link resting on a
convention rather than a declaration is struck off the top: `name-convention`, `unique-name`,
`method-missing`. That second half was added in 2026-08-23, because an assumption that **resolves**
a call flatters the headline exactly as much as one that excuses it, and counting only the latter
made the self-audit a half-audit. `bench` prints the guessed links so the gap is inspectable.

Read the two columns together. spring-petclinic is 99.7% on one guessed link in the whole repo.
express is 89.2% on a floor of 57.7% — plain JS annotates nothing, so most of its receivers are
runtime judgements. mastodon and rubygems.org sit near 88% with floors near 78%, which is what
Rails looks like when half the receivers are named after their model and nothing else says so.

The graph grew far more than the percentages did: halo went from 26,654 edges to 34,784, mastodon
from 21,748 to 27,612, rubygems.org from 10,253 to 13,050. Several numbers *fell* along the way and
were kept — when Lombok members and `delegate` forwards entered the index, names that had been
**proven** to live outside the repo no longer were, so the denominator grew and honest new misses
appeared with it. Lower number, more complete graph, every time.

Re-measure any time with `./scripts/bench.js <repo> --detail`, which prints the miss buckets and
the guessed links as well as the two headline figures.

### What is still missed, and why

**A receiver typed only by a dependency.** `contextRunner.run(context -> context.getBean(...))`
types `context` from Spring Boot's signature; `Mono<T>` types halo's reactive chains from Reactor's;
`intl.formatMessage(...)` from react-intl's. Everything downstream of such a receiver is
unresolvable, and not because of a gap in this tool: on the machine these numbers were measured on,
those declarations **are not present at all** — the clones have no `node_modules`, and there is no
`~/.m2` or `~/.gradle` cache. No tool can resolve what is not there.

That is what separates the two halves of the table. spring-cloud-aws is 76% Mockito, AssertJ and
Spring test harness by call volume; halo is written in Reactor throughout. Reading dependency
declarations — `.d.ts` from `node_modules`, signatures from JARs — is the one change that would
move them, and it needs the dependencies installed first.

**A receiver nothing declares at all.** A method parameter in a dynamically typed language names no
type anywhere, so `def deliver(recipient)` gives the resolver the name and nothing else. That is why
the naming convention exists, why it is capped at 0.5, and why it is struck out of the floor. It is
also why mastodon and rubygems.org read ~88% with floors near 80%: roughly 6% of their links rest on
a convention. No amount of engineering turns that into a declaration, because Ruby never wrote one.

## Commands

| Command | What it does |
|---|---|
| `codelens init [path]` | Create `.codelens/` and build the index for the first time |
| `codelens sync [-w]` | Reparse changed files; `-w` keeps watching |
| `codelens index` | Rebuild everything |
| `codelens status` | Coverage, resolution quality, binding counts |
| `codelens query <name>` | Find symbols by name |
| `codelens explore <name>` | Source + call paths + bindings + blast radius, in one shot |
| `codelens node <name>` | One symbol in full, with callers and callees |
| `codelens callers <name>` / `callees <name>` | One direction of the relationship |
| `codelens impact <name>` | Blast radius |
| `codelens path <from> <to>` | **Shortest directed chain** between two symbols, hop by hop — across repositories when a binding bridges them |
| `codelens affected [files...] [--fail-if-untested]` | What changed files reach, and **which tests already cover it**; the flag exits 2 when nothing does — a CI gate |
| `codelens export [name] [-f json\|mermaid]` | The graph around a symbol as JSON or a **Mermaid diagram** ready for a README or PR |
| `codelens install [target]` | Register the MCP server with an agent (`--dry-run` to preview) |
| `codelens uninit [path]` | Remove the index from a project |
| `codelens serve [paths...] [-p 7777] [-o] [--new-token]` | **Web UI** — search and browse the graph, one repo or **many at once** |
| `codelens mcp [path]` | MCP server over stdio |

`query`, `callers`, `callees`, `impact`, `path`, `export` and `affected` all accept `--json` for
piping into other tools.

**Workspaces.** Every read command accepts a folder of service checkouts, not just one repository:
run from such a folder, `query`/`explore`/`status` answer per repository under its own heading, the
symbol commands resolve the name to whichever repo holds it (and say so when several match), and
`path` bridges repositories through framework bindings:

```
# Path: com.shop.OrderPublisher#publishOrder → OrderAuditWorker#record  (order-service → audit-service)

com.shop.OrderPublisher#publishOrder — src/OrderPublisher.java:6
  ══╡ sqs: order-events ╞══  crosses into audit-service
OrderAuditWorker — app/workers/order_audit_worker.rb:1
  └─ declares [structure]
OrderAuditWorker#record — app/workers/order_audit_worker.rb:7

2 hop(s) across two repositories.
```

### Web UI

```bash
codelens serve --open
```

**Several repositories at once.** Point it at a folder holding multiple services and it finds every
initialised repo inside:

```bash
codelens serve ~/work/services --open
```

Or list them explicitly: `codelens serve ./order-service ./notify-service`.

The toolbar has a repository dropdown — **"All repos" shows every one of them**, picking one
narrows the view to it. Clicking a repository's hub on the canvas moves the dropdown too, so the
two never disagree about what you are looking at. Each repo gets its own hue, drawn as a **ring
around the node** so it never fights the symbol-kind colour; while the view is scoped, the dropdown
wears that same hue.

**Cross-repo edges.** This is the actual reason to open several repos at once: an SQS producer in
one service and its listener in another are connected only by **the queue name**, with no call
between them. codelens matches binding endpoints across the separate indexes and draws them as
**dashed teal lines labelled with the queue**:

```
order-service:publishOrder  ──sqs: order-events──▶  notify-service:onOrder     (Java)
                            └─sqs: order-events──▶  audit-service:OrderAuditWorker  (Ruby)
```

Across repos **and** across languages. Symbols are addressed as `repo:id`, because each index
numbers its symbols from 1 — bare IDs would collide the moment a second repo is opened.

A graph is drawn **as soon as the page loads**, before you search anything: the top hubs of each
repository, plus whatever cross-repo links exist. Type to find a symbol, click to read the real
source with line numbers, then **click any link to keep walking the graph** — callers, callees,
type relationships, framework bindings, blast radius. Derived symbols (a `belongs_to` reader, a
database column, a SQL statement in XML) are labelled `derived`; test files are labelled `test`.
`/` returns to the search box, arrow keys move through results, and the detail panel can be dragged
wider by its left edge. Typing **`A -> B`** in the search box traces the shortest chain between two
symbols and draws just that chain — the same walk `codelens path` does, bindings and all.

**Themes.** Seven editor palettes, remembered across sessions: Solarized Dark (default), Solarized
Light, Gruvbox Dark, Monokai, Nord, One Dark, and **Matrix** — black background, green monospace,
glowing nodes. Solarized leads because it was designed for reduced eye strain rather than maximum
contrast; Matrix breaks that rule deliberately, since that is the whole point of it.

One self-contained page. No build step, no external dependency, no CDN — the strict CSP would block
one anyway.

The server **binds to `127.0.0.1` only, is read-only**, and keeps its indexes fresh with a file
watcher.

Three layers of protection, each with a regression test in `test/server.test.js`:

- **A token on every data route** (Jupyter style), compared with `timingSafeEqual`. Stops another
  process on this machine from reading your index through the API. It is stored at
  `$XDG_STATE_HOME/codelens/ui-token` (mode 0600) and reused across restarts, so the URL stays
  bookmarkable; `serve --new-token` rotates it. The page keeps it in `localStorage` rather than a
  cookie, because cookies ignore the port — a cookie set for `127.0.0.1` would be handed to every
  other dev server you run. The token is stripped from the address bar on arrival, so it never
  reaches history. The empty shell at `/` is served without it: it holds no repository data, and
  gating it is what made bookmarks impossible. Worth knowing what this is and is not worth — a
  process running as you can read the index files straight off disk without asking the server.
- **A `Host` check** — blocks DNS rebinding, where a malicious page points its own DNS at
  `127.0.0.1` to read your API. Binding to loopback alone does not stop that.
- **No CORS headers** — a cross-origin page can send a request but cannot read the response.

### Daily workflow

```bash
git diff --name-only | codelens affected
```

That returns which symbols changed, what reaches them, and **which existing tests cover them** — in
other words, the list of tests to re-run. On spring-petclinic, touching `Owner.java` produces 18
relevant tests.

As a pre-push gate, `--fail-if-untested` exits 2 when the diff touches production code that no
existing test reaches:

```bash
git diff --name-only | codelens affected --fail-if-untested
```

## Using it from Claude Code

```bash
codelens install claude-user
```

It prints the change before writing and always keeps a `.bak`. Targets are `claude-user`,
`claude-project` and `cursor`. Or do it by hand:

```bash
claude mcp add codelens -- node ~/AI-TOOL/codelens/bin/codelens.js mcp
```

Four tools: `codelens_explore`, `codelens_impact`, `codelens_affected`, `codelens_status`. Each
takes a `projectPath`, so **one server serves every repository** — and a `projectPath` naming a
folder of checkouts serves them **all at once**, each answer labelled with the repository it came
from. Indexes stay current through the file watcher.

`codelens install` only auto-detects agents that already have a config file. The project-scoped
variant (`.mcp.json` in the current directory) is **never** automatic — you have to name it
explicitly, so a config file can never be dropped into a team repo by accident.

## Architecture

```
src/lang.js              loads the WASM grammars (web-tree-sitter)
src/project.js           walks files, respecting .gitignore
src/extract/{java,ruby,typescript}.js   AST → symbols / imports / locals / call sites
src/resolve/{java,ruby,typescript}.js   call site → real definition   ← the hard part
src/bindings/index.js    plugin framework + provider/consumer matching
src/bindings/{mybatis,camel,sqs,flyway}.js
src/schema/rails.js      db/schema.rb → ActiveRecord attributes
src/indexer.js           extract → SQLite → resolve → bindings
src/query.js             lookup, callers/callees, blast radius
src/format.js            text payloads for the agent
src/server.js            read-only multi-repo HTTP server
src/ui/app.html          the web UI, one self-contained page
src/watch.js             auto-sync
src/mcp.js               JSON-RPC over stdio, hand-rolled, no extra dependency
scripts/ast.js           dump an AST — for writing a new extractor
scripts/bench.js         measure quality against real repositories
```

### Edge confidence

Every edge carries a `confidence` and a `via` note explaining how it was derived, so a wrong edge
can be traced back:

| conf. | via | Meaning |
|---|---|---|
| 1.0 | `direct` | Receiver type known, method found on it or on a superclass |
| 0.95 | `binding:mybatis` | Mapper method ↔ SQL statement with the same id |
| 0.9 | `interface->impl` | Receiver is an interface → linked to the implementation |
| 0.9 | `binding:camel` | Same endpoint URI |
| 0.85 | `binding:sqs` | Same queue name |
| 0.8 | `rails-association` | Type inferred from a reader generated by `belongs_to`/`has_many` |
| 0.7 | `self-chain`, `module->includer` | Through the ancestor chain or a mixin |
| 0.6 | `binding:flyway` | Table ↔ entity matched **by naming convention** |
| 0.5 | `name-convention` | Ruby only: a variable named after its model, **and** that model declares the member being called |
| 0.5 / 0.4 | `unique-name` | No type information, exactly one method with that name (lower for Ruby) |
| 0.4 | `method-missing` | Ruby only: the whole ancestor chain failed and the class declares `method_missing` |

The `unique-name` fallback is **suppressed** when the name is a runtime built-in: linking `xs.map()`
to some arbitrary `map` method in the repo is inventing an edge, not inferring one.

Plugin-generated symbols (SQL statements, routes, migrations) are marked `generated`, and `explore`
says so explicitly: *"derived, not written in this file"*.

### Why walk the AST by hand instead of using tree-sitter queries

Query strings break **silently** when a grammar changes version — they still run, they just return
zero matches. Walking by hand is longer but fails where the failure is. Use `scripts/ast.js <file>`
to see the real tree.

### Pinned versions

`web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`. Runtime 0.26 **cannot load** 0.1.13
grammars (an ABI error at `Language.load`). Both are pinned to exact versions, which doubles as a
supply-chain measure: `yarn.lock` is committed with integrity hashes, so
`yarn install --frozen-lockfile` reproduces the same tree every time and fails loudly rather than
silently resolving something new.

### Schema changes rebuild the index

The index is a cache. Bumping `SCHEMA_VERSION` in `src/db.js` deletes the stale index and rebuilds
it automatically.

## Tests

```bash
yarn test
```

179 tests across five fixture suites plus regression, security and multi-repo coverage:

| Fixture | Simulates | The chain grep cannot follow |
|---|---|---|
| `java` | Spring: Controller → Service interface → Impl → Repository interface | DI across two interface layers, plus same-arity overloads |
| `ruby` | Rails: model, concern, service object, controller | `donor.name` — `donor` generated by `belongs_to`, `name` by `attr_reader` |
| `ts` | TS + JS: barrel files, tsconfig aliases, constructor DI | an import through `export *` before reaching the real class |
| `bindings` | MyBatis + Camel + SQS + Flyway | a Java producer → a Ruby Shoryuken worker, matched on queue name |
| all of `__fixtures__` | One repo containing all four languages | resolvers not wiping each other's graphs |

`test/regressions.test.js` locks down every bug that has been fixed: LIKE wildcards, scoring order,
duplicate edge collapsing, file accounting on sync, the watcher's ignore rules, test detection, and
empty / syntactically broken / Vietnamese-and-emoji files.

The tests assert that the Java and Ruby fixtures have **zero misses**, and that everything else is
attributed to the right library. If a resolver later drops an internal call, a test goes red.

## Known limits

- **A receiver typed only by a library** is the largest miss bucket, and the reason the reactive
  and test-harness rows sit lowest. Types propagate along a chain while every link is in the repo;
  the moment one is declared in a JAR, a gem or `node_modules`, the chain stops.
- **A callback parameter in JavaScript** is the sharpest form of that. `startHTTPServer((req, res)
  => res.end(...))` says nothing about `res` anywhere, and neither does the helper it is passed to.
  Reported as a miss rather than guessed, which is most of why axios reads 64.7%.
- **Node object-modules** — `var app = module.exports = {}` then `app.set = function(){}` — are not
  modelled, so their members look external. Modelling them is correct in principle: express really
  does define `res.send`. It is left out because without a way to type the `req`/`res` parameters
  that receive them it turns ~900 express calls from proven-library into unresolvable, taking the
  repo from 91% to 29%. Half of that change is worse than none.
- **The Ruby inflector** is simple and does not handle irregulars (`people`/`person`).
- **Annotation-style MyBatis** (`@Select` on the method) needs no binding — the SQL is already in
  the method.
- **NestJS token DI** (`{ provide: 'X', useClass: Y }` matched to `@Inject('X')`) needs
  object-literal extraction the TS extractor does not do yet; decorators themselves are recorded.

## Roadmap

- [ ] NestJS custom-provider tokens as a binding plugin (needs object-literal extraction)
- [ ] Read `.d.ts` from `node_modules` and signatures from JARs, to keep a chain alive past a
      library hop. This is now the single change that would move halo, spring-cloud-aws, nest and
      typeorm, and the benchmark says so plainly: every repository that misses 90% on the floor
      misses it because a dependency, not the repository, declares the receiver's type. It needs
      the dependencies installed first — the measurement above was taken on bare clones, with no
      `node_modules` and no `~/.m2`.
