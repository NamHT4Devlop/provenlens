# provenlens

A personal code knowledge graph for **Java, Ruby, TypeScript and JavaScript** — plus a
**string-binding** layer that connects the places a call graph structurally cannot see, in
**nine plugins**: MyBatis, Camel, SQS, Kafka, HTTP routes, Spring events, GraphQL, gRPC, Flyway.

## TL;DR

provenlens pre-indexes a codebase into a graph of symbols and who-calls-what, stored in SQLite, so
an AI agent can ask **one question** and get everything: the real source with line numbers, what
calls this, what this calls, and what breaks if you change it — instead of a dozen rounds of grep
and file reads.

It runs **100% offline**. No API calls, no telemetry, no network egress of any kind, and **nothing
to compile** — `node:sqlite` ships inside Node 22+, and the grammars are WASM.

## What is different about this one

Indexing code into a call graph is old work — ctags has done a version of it since 1992. The three
things below are what this particular attempt is for, and each of them is a position you can hold
against it.

**It tells you how much of its own answer it is unsure about.** Every measurement comes as two
numbers: what resolved, and what would be left if *every* judgement made without a declaration
behind it turned out to be wrong. A link that rests on a naming convention is struck out of the
second number, so an assumption cannot flatter the score without showing up as a gap. Across two
independent samples totalling 15,000 repositories, **84% of all call sites that could land in their
own repository did**; the median repository reads higher and the benchmark table below sits far
lower, because it is deliberately made of hard cases.

**A lower number is allowed to be the right answer.** `StoryRender<T> | CsfDocsRender<T> |
MdxDocsRender<T>` names three types and the call could be reaching any of them, so the graph
refuses rather than picking the first — and gives up coverage doing it. Several changes in this
history moved the score *down* and were kept, each one recorded in the table of experiments that
did not work, with the number it cost.

**The claims are measured, on 15,000 repositories** across two samples drawn a different way. 178.6
million call sites, four languages, cloned and indexed and thrown away. It is also how the worst
defects here were found: a parse tree leaking into a WebAssembly heap, V8's 4 GB ceiling, and a
minified bundle parsed into 7,996 symbols. None was reachable from a curated set.

None of that makes it better than the alternatives at finding a caller. It makes it answerable
about when it is guessing, which is the property that matters when the thing reading the output is
an agent that cannot tell.

---

## Setup

### 1. Requirements

| | Why |
|---|---|
| **Node.js 22 or newer** | provenlens uses `node:sqlite`, which only exists from Node 22. Nothing else is needed — no compiler, no native modules, no database server. |
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
git clone git@github.com:NamHT4Devlop/provenlens.git ~/AI-TOOL/provenlens
```

```bash
cd ~/AI-TOOL/provenlens && yarn install
```

That pulls exactly four packages: `commander`, `ignore`, `web-tree-sitter` and
`tree-sitter-wasms`. Four is the whole tree — **they bring no transitive dependencies at all** —
and each is pinned to an exact version (no `^`, no `~`), so a fresh install today resolves to the
same bytes it resolved to when the benchmarks below were measured. `yarn audit` reports 0
vulnerabilities across all four.

### 3. Put `provenlens` on your PATH

```bash
ln -sf ~/AI-TOOL/provenlens/bin/provenlens.js ~/.local/bin/provenlens
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
provenlens --version
```

### 4. Index your first repository

Every repository must be indexed once before any other command works:

```bash
cd /path/to/your/repo && provenlens init .
```

You should see something like this — the last line is the resolver reporting how much of the call
graph it managed to connect:

```
created .provenlens/ in /path/to/your/repo
indexed 2 file(s), 6 symbol(s)
java: 1 direct, 0 via impl, 0 by name, 0 missed, 0 library (100.0% of in-repo calls linked)
```

The index lives in `.provenlens/` at the repo root. It is a **cache** — safe to delete, rebuilt on
demand, and it should never be committed. Add `.provenlens/` to your global gitignore so it can
never land in a team repository:

```bash
echo '.provenlens/' >> "$(git config --global core.excludesfile || echo ~/.config/git/ignore)"
```

That appends to whichever file git is actually configured to read; `git config --global
core.excludesfile` on its own tells you which one that is.

### 5. Ask it something

```bash
provenlens explore "OwnerController"
```

`explore` is the one command worth remembering — it returns the real source with line numbers, the
call paths in and out, framework bindings, and the blast radius, all in a single response:

````
# provenlens explore: "OwnerController"

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
provenlens callers "wrap"
```

```
# Callers of demo.Formatter#wrap
src/Formatter.java:3

### Callers (1)
- demo.Greeter#greet — src/Greeter.java:5 [direct]
```

### 5b. Optional — install the project's dependencies

provenlens reads type declarations from a project's dependencies, so a call chain
can be typed *through* a library instead of stopping at one. Nothing is required
for this; it simply uses what is already on disk.

| Language | What is read | How to have it |
|---|---|---|
| TypeScript / JavaScript | `.d.ts` of the packages the code imports | `npm install` / `yarn` / `pnpm install` |
| Java | signatures via `javap` — the JDK's own classes, plus any jar a build tool has fetched | a JDK on `PATH`; `./mvnw` or `./gradlew` for third-party jars |

The JDK half needs no download at all, which is most of what it is worth: `Optional`, `List` and
`CompletableFuture` stop being assumptions and become proofs, and the floor figure rises with them.

Whatever is read this way is marked external. It never appears in a search, never counts towards
coverage, and is never the target of an edge — a call landing there is a **library call, proven by
the declaration** rather than assumed from a name.

```bash
provenlens status
```

```
dependencies read: 15 package(s); 285 declaration file(s), 312 jvm type(s)
```

### 6. Keep the index fresh

The index does not update itself unless you ask it to. Three options, cheapest first:

```bash
provenlens sync
```

```bash
provenlens sync -w
```

```bash
provenlens index
```

`sync` reparses only the files whose contents changed, `-w` keeps watching in the background, and
`index` rebuilds everything from scratch. `provenlens serve` and the MCP server each run a watcher of
their own, so if you use either of those you rarely need to sync by hand.

### 7. Check the index is healthy

```bash
provenlens status
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
provenlens serve --open
```

It prints two URLs:

```
provenlens UI on http://127.0.0.1:7777/?token=ecf03d237e77307bc12f255bea265623
bookmark:   http://127.0.0.1:7777/
```

Open the first one once. The page keeps the token, so from then on the short one is enough —
bookmark that. The token is stored under your state directory and reused on every restart, so the
bookmark keeps working tomorrow. `provenlens serve --new-token` retires it if you ever want it gone.

### 9. Optional — wire it into Claude Code

```bash
provenlens install claude-user
```

This prints the change before writing it and always leaves a `.bak`. See
[Using it from Claude Code](#using-it-from-claude-code) for the manual form and for what the four
MCP tools do.

### Uninstalling

```bash
provenlens uninit /path/to/repo
```

```bash
rm ~/.local/bin/provenlens
```

```bash
rm -rf ~/AI-TOOL/provenlens
```

The first removes one repository's index, the second removes the command, the third removes
provenlens itself.

### Troubleshooting setup

| Symptom | Cause and fix |
|---|---|
| `zsh: command not found: provenlens` | The symlink is missing, or `~/.local/bin` is not on your PATH. Run `ls -l ~/.local/bin/provenlens` and `echo $PATH` to see which. |
| `Cannot find module 'node:sqlite'` | Node is older than 22. Check `node -v`, then upgrade. |
| `no index — run: provenlens init` | That repository has never been indexed. `cd` into it and run `provenlens init .`. |
| A `Language.load` / ABI error on first run | Something upgraded `web-tree-sitter` past 0.25.10. Run `yarn install --frozen-lockfile` to restore the pinned versions — see [Pinned versions](#pinned-versions). |
| `EADDRINUSE` from `provenlens serve` | Port 7777 is already taken, most likely by an earlier `serve`. Use `provenlens serve -p 7800`, or stop the old one. |
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
| `http` | A URL is a string on both sides: `@GetMapping`/`@Get`/`app.get`/`config/routes.rb` declare the handler, an HTTP client naming a path calls it — **across services** | `calls-route` (0.8) |
| `grpc` | `rpc GetOrder` in a `.proto` ↔ a class extending `OrderServiceGrpc.OrderServiceImplBase` — **each rpc becomes a symbol**, and the generated base's `GetOrder`→`getOrder` rename is followed | `implemented-by` (0.9) |
| `graphql` | `type Query { orders }` in a `.graphqls` ↔ `@QueryMapping` / NestJS `@Query({ name })` — **each schema field becomes a symbol**, and a field nobody implements stays visible | `implemented-by` (0.9) |
| `spring-event` | `publishEvent(new OrderPlaced(…))` ↔ `@EventListener void on(OrderPlaced e)` — the shared token is a **type name**, not a string | `publishes-to` (0.8) |
| `kafka` | A topic is a string on both sides: `@KafkaListener`/NestJS `@EventPattern`/KafkaJS `subscribe`/Karafka `topic :x` declare the handler, a producer naming the same topic reaches it — **across languages** | `sends-to` (0.85) |

SQL statements in XML and each migration file **become real symbols** — `provenlens explore
"OrderMapper#findById"` returns both the Java signature and the SQL that will actually run.

Camel and SQS shake hands too: a route publishing to `aws2-sqs:order-events` links straight through
to a `@SqsListener` and to a Ruby worker consuming the same queue.

**Only a topic the source spells out.** `@KafkaListener(topics = "${app.topic.audit}")` names a
configuration key whose value lives in a file the index does not read, and `subscribe({ topic })`
names a variable. Both produce no endpoint: wiring two services together on the spelling of a key
would be an invention, and the floor exists to keep inventions out. On spring-kafka that leaves 97
topics and **93 links a call graph could not see** — while kafkajs's own suite, which passes topic
names as variables, yields almost none. Both numbers are correct.

A group id is not a topic. `@KafkaListener(id = "one", topics = "orders", containerGroup = "g1")`
hands the extractor three strings and no attribute names, so the annotation is read again from the
file: whatever `topics =` names, and nothing else.

**Adding a new framework** means adding one file to `src/bindings/` that declares `accepts` (which
files to read) and `collect` (emit providers and consumers with a shared `key`). The matching and
edge creation are shared.

## Reading the numbers honestly

In a real Spring application, **46–59% of all calls target a class inside a JAR**. Counting those
as "unresolved" makes the metric meaningless. provenlens splits three ways:

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

### Measured across five thousand repositories

The forty-three below were chosen one at a time and read closely. That is how the bugs were found,
and it is also how the table came to be unrepresentative: nearly every one of them is a large
framework, and large is the hard case.

So the same measurement was run over **5,000 repositories cloned from GitHub** — 1,250 per language,
sampled across star bands from 200 upward, cloned shallow, indexed, and deleted. 4,981 completed:
**136.5 million call sites across 2.6 million files**. Discarding the 499 too small to say anything
(under 200 call sites — a two-file package reading 100% is not evidence), 4,482 remain.

| Language | Repos | Median | Mean | Weighted by call sites | Clear 90% |
|---|---:|---:|---:|---:|---:|
| java | 1141 | **95.9%** | 94.1% | 89.9% | **83%** |
| ruby | 1149 | **94.6%** | 92.7% | 83.0% | **71%** |
| typescript | 1143 | **92.3%** | 88.8% | 84.5% | 59% |
| javascript | 1049 | **88.7%** | 82.1% | 72.0% | 48% |
| **all** | **4482** | **94.0%** | 89.6% | 83.9% | **66%** |

**The median repository reads 94.0%, and two in three clear 90%.** The weighted column is the honest
counterweight: bigger repositories are harder, and weighting by call sites pulls the same population
down to 83.9%.

Size is the variable, and it is monotonic:

| Call sites | Repos | Median | Clear 90% |
|---|---:|---:|---:|
| 200 – 1,000 | 1024 | **98.9%** | 83% |
| 1,000 – 5,000 | 1413 | 96.0% | 74% |
| 5,000 – 20,000 | 1047 | 91.9% | 59% |
| 20,000 – 100,000 | 691 | 88.7% | 44% |
| 100,000+ | 307 | **86.7%** | 39% |

Only **6.8%** of the 5,000 sit in that last band — and the forty-three below are drawn almost
entirely from it. The table is not a typical sample. It is close to a worst case, which is what makes
it useful for finding bugs and misleading as a summary. Both are now stated.

### Run again over ten thousand, and the two samples agree where it counts

The 5,000 above were sampled from **200 stars upward**. A second run took **10,000 repositories from
5 stars upward** — 2,500 per language, across eleven star bands — which is a different population:
mostly smaller, and far fewer of the large repositories that are hard. **9,946 indexed, one clone
failed, 53 were skipped above 400 MB, and nothing crashed or timed out.** Read under the same rule as
the table above (repositories under 200 call sites discarded), 6,274 remain and **42.1 million call
sites** with them.

| Language | Repos | Median | Mean | Weighted by call sites | Clear 90% |
|---|---:|---:|---:|---:|---:|
| java | 1774 | **97.8%** | 95.4% | 89.0% | **87%** |
| ruby | 1744 | **97.9%** | 95.5% | 85.6% | **86%** |
| typescript | 1527 | **97.8%** | 93.0% | 84.6% | **76%** |
| javascript | 1229 | **95.3%** | 88.0% | 71.5% | **62%** |
| **all** | **6274** | **97.6%** | 93.4% | **84.1%** | **79%** |

The medians are higher than the 5,000's — 97.6% against 94.0% — and that is the **sampling**, not the
tool. Only 1.1% of this sample sits above 100,000 call sites, against 6.8% of the other, and size is
what decides the number:

| Call sites | Repos | Median | Clear 90% |
|---|---:|---:|---:|
| 200 – 1,000 | 3119 | **99.7%** | 86% |
| 1,000 – 5,000 | 1994 | 96.7% | 79% |
| 5,000 – 20,000 | 791 | 94.2% | 67% |
| 20,000 – 100,000 | 302 | 89.8% | 49% |
| 100,000+ | 68 | **77.7%** | 23% |

**The column that removes the sampling difference gives the same answer twice.** Weighting by call
sites asks what share of all the calls in the population got linked, and it does not care how many
repositories were small: 5,000 repositories from 200 stars up read **83.9%**, and 10,000 from 5 stars
up read **84.1%**. Two samples drawn a different way, 178.6 million call sites between them, and
0.2 points apart. Neither median is the honest headline on its own; this is.

Ruby moved most between the two runs — 94.6% median to 97.9% — and that is sampling again in its
sharpest form: Ruby's weighted figure is 85.6%, the second-lowest of the four. The median Ruby
repository is small enough to read almost perfectly and the large ones are the worst rows in the
table above, which is the whole reason both numbers are printed.

This prediction was written down before the run and was wrong in both halves: that the average would
*fall*, and that Ruby would be what pulled it down. Ruby came second at a 94.6% median. The reasoning
behind the prediction — that Ruby declares no receiver types — is still true, and still explains
Ruby's weighted 83.0%. It just does not describe the median Ruby repository, which is small enough
that most of its receivers are local and named where they are made.

The scale paid for itself three times over, on defects no curated set could reach:

- **A parse tree leaked into WebAssembly.** 1,121 MB over 6,000 files against 151 MB freed, and an
  Emscripten abort somewhere inside JetBrainsRuntime's 53,577 — surfacing as `table index is out of
  bounds` at the *next* parser the run asked for, because the `try` around the parse swallowed it.
  Found on the fortieth repository of the pilot batch.
- **V8's 4 GB heap cap.** The resolver is deliberately in-memory, and google-cloud-ruby's 31,023 Ruby
  files need 7.3 GB. Two repositories in 5,000 hit it, and they were only distinguishable from the
  eight that merely ran long because a signal exit is 128+n rather than 0.
- **A file whose name lied about its contents.** shaka-player carries 113 MPEG-2 transport streams
  named `.ts`, and 49 MB of video handed to the TypeScript grammar built an error tree the size of
  the video: 898 source files had not finished indexing after ten minutes, 83% of it inside
  tree-sitter's `ts_node__child`. A NUL byte in the first 8000 characters — git's own test — now
  refuses them, and the repository indexes in 6.2 seconds.

Eight repositories exceeded a ten-minute budget and one clone failed; those are harness limits, not
results. Eight more were skipped above 1.5 GB, all of them asset monorepos.

### The forty-three read closely

Forty-three repositories, none of them chosen for its score. They were added in four rounds, each
named in advance, and each round pulled the median down: the first eleven sat at 91.4%, and all
forty-three bring it to 88.7%. That is what picking before measuring costs, and it is the only way
the table means anything.

The later rounds were picked for **structural variety** rather than difficulty — pnpm workspaces,
Maven and Gradle multi-modules, a NestJS monorepo, Ruby gems, a Rails app, a Rails framework —
because a repository laid out in a way I had not tried is where the bugs were. Eight real ones came
out of those two rounds, and every fix is in its own commit with the repository that exposed it.

**Twelve clear 90% on both columns, nineteen on the headline, and all forty-three index without
crashing.**

The Java repositories were measured with their dependencies **installed** — a JDK plus the jars
Maven and Gradle had already fetched. Reading real declarations replaces guesses with facts in both
directions, which is why camel fell from 97.3% to 95.2% once its types became readable enough to be
counted properly.

The **JavaScript and TypeScript** clones were measured **bare**, with no `node_modules`. That is the
weaker configuration, and it was worth checking what it costs rather than assuming. Installing zod's
dependencies moved it **from 75.7% to 75.7%** — not a rounding difference, the same number. The
declarations were read (`doctor` stops reporting a missing tree and starts naming the twelve
specifiers that have no types, four of which are path aliases), and the miss shape did not move
either: **3939 of 4029 misses, 97.8%, are `complex-receiver-chain`** — a chained expression whose
receiver the resolver cannot type, which no amount of installing fixes.

nest, typeorm and axios have their `node_modules` present and read **90.9%, 88.2% and 76.1%**. So
a dependency tree is not what separates these repositories from 90%.

| Repo | Stack | In-repo resolution | Floor if every assumption were wrong |
|---|---|---|---|
| spring-petclinic | Spring Boot + Data, 51 files | **99.7%** | **98.6%** |
| mall | Spring Boot + MyBatis, 630 files | **99.4%** | **99.3%** |
| mybatis spring-boot-starter | MyBatis, 154 files | **98.5%** | **98.5%** |
| TheAlgorithms/Java | plain Java, 1588 files | **98.1%** | **97.5%** |
| nx | TS monorepo, 5305 files | **95.6%** | 89.6% |
| camel-spring-boot-examples | ~50 Camel examples, 325 files | **95.2%** | **94.7%** |
| mybatis jpetstore | MyBatis + Flyway, 43 files | **95.1%** | **95.1%** |
| devise | Rails engine, Ruby | **94.4%** | 85.0% |
| google/guava | Java, Maven | **94.5%** | **93.8%** |
| vuejs/core | TS pnpm workspace, 527 files | **93.9%** | 86.8% |
| spring-framework | Gradle multi-module, 9901 files | **93.6%** | **92.0%** |
| apache/dubbo | Maven multi-module, 4190 files | **93.1%** | **91.6%** |
| date-fns | JS, monorepo | **92.9%** | 83.5% |
| jenkins | Java, Maven | **92.7%** | **90.6%** |
| apache/kafka | Gradle multi-module, 6196 files | **92.4%** | **91.2%** |
| express | plain JS, 141 files | **91.4%** | **91.1%** |
| java-design-patterns | Java, 1991 files | **91.5%** | 89.8% |
| immich | NestJS + Svelte monorepo | **91.6%** | 85.5% |
| nest | TS, 1904 files | **91.1%** | 87.0% |
| puma | Ruby | **89.1%** | 77.9% |
| micronaut-core | Java, Gradle | **88.7%** | 86.2% |
| sinatra | Ruby, 147 files | **88.5%** | 81.4% |
| typeorm | TS, 3575 files | **88.7%** | 83.3% |
| spring-cloud-aws | Java, 816 files | **88.5%** | 87.2% |
| rubygems.org | Rails, 1392 files | **88.2%** | 80.4% |
| mastodon | Rails + TS, 4199 files | **87.6%** | 80.1% |
| halo | Java + TS, 2228 files | **87.6%** | 85.5% |
| prettier | JS + TS, 5762 files | **89.2%** | 70.4% |
| storybook | TS monorepo | **87.9%** | 77.6% |
| medusa | TS monorepo | **87.4%** | 74.3% |
| fastlane | Ruby, 1340 files | **86.7%** | 77.4% |
| sidekiq | Ruby | **85.9%** | 79.7% |
| quarkus | Java, Maven multi-module | **85.2%** | 82.2% |
| jekyll | Ruby, 171 files | **84.5%** | 75.0% |
| solidus | Rails, 2329 files | **83.5%** | 74.8% |
| svelte | JS + TS monorepo | **87.9%** | 75.1% |
| redmine | Rails app | **81.4%** | 72.7% |
| astro | TS monorepo | **81.3%** | 69.6% |
| trpc | TS monorepo | **80.0%** | 73.8% |
| discourse | Rails, 14358 files | **78.7%** | 72.8% |
| axios | JS, 242 files | **76.0%** | 69.0% |
| zod | TS pnpm workspace | **75.7%** | 62.1% |
| rails | Rails framework | **74.8%** | 62.6% |

**Twelve of the forty-three clear 90% on both columns**, and which twelve is the most useful thing
the table says. Several rows moved *down* on the way there and were kept: an import naming a library
type used to fall through to a same-named class in the repository, and nest lost about 3% of its
links when that stopped. Those links were inventions.

The table does not sort by repository size, and it does not sort by language. It sorts by **who
declares the receiver's type**:

- Types declared *inside the repository* — Spring with Lombok, MyBatis, plain Java, a small
  self-contained JS package. Every one of these clears 90% on the headline, and all but
  java-design-patterns clears it on the floor as well — that one lands at 89.6%, just under.
- Types declared by a **dependency** — Reactor in halo, the Spring test harness in
  spring-cloud-aws, TypeORM's own generics. These declarations *are* now read, and reading them is
  most of what these rows are made of: halo went from 77.0% to 87.6%, typeorm from 71.8% to 88.2%,
  immich from 68.5% to 91.6%, trpc from 60.1% to 80.4%.
  What is left is the part reading cannot fix: a signature like `Flux<T>.map(Function<T,R>)`
  answers with type *variables*, and substituting them properly is a different job from reading
  them.
- Types declared **nowhere** — Ruby, and JavaScript callbacks. `axios` is the clearest case in the
  table: its tests are written as `startHTTPServer((req, res) => res.end(...))`, and nothing in
  JavaScript ever says what `res` is. 76.1% is the honest reading of that, not a defect. It read
  67.6% until `export default` was read as an export rather than guessed at by name, which is worth
  saying plainly: two thirds of what looked like the language's fault was the reader's.

**Two numbers, and the second is the one that keeps the first honest.** The floor assumes every
judgement the resolver made without a declaration behind it was wrong — both directions. Calls
excused as runtime built-ins come back into the denominator, *and* every link resting on a
convention rather than a declaration is struck off the top: `name-convention`, `unique-name`,
`method-missing`. That second half was added in 2026-08-23, because an assumption that **resolves**
a call flatters the headline exactly as much as one that excuses it, and counting only the latter
made the self-audit a half-audit. `bench` prints the guessed links so the gap is inspectable.

Read the two columns together. spring-petclinic is 99.7% on one guessed link in the whole repo.
axios is 76.1% on a floor of 69.1% — plain JS annotates nothing, so a fifteenth of what it *does*
link rests on a convention rather than a declaration. mastodon and rubygems.org sit near 88% with floors
near 80%, which is what Rails looks like when half the receivers are named after their model and
nothing else says so.

The graph grew far more than the percentages did: halo went from 26,654 edges to 36,154, mastodon
from 21,748 to 27,634, rubygems.org from 10,253 to 13,052. Several numbers *fell* along the way and
were kept — when Lombok members and `delegate` forwards entered the index, names that had been
**proven** to live outside the repo no longer were, so the denominator grew and honest new misses
appeared with it. Lower number, more complete graph, every time.

Re-measure any time with `./scripts/bench.js <repo> --detail`, which prints the miss buckets and
the guessed links as well as the two headline figures.

### Why the last twenty-four will not reach 90%, and what was tried

The obvious levers were pulled and measured, and most of them did nothing:

| Tried | Result |
|---|---|
| **Install every missing dependency** (9 repos, npm/pnpm/yarn) | nx 95.4 → 95.5, astro unchanged, svelte +0.1. **No effect.** |
| **Read JSDoc** — `@param {T}` and `@import` | svelte 82.4 → **87.9%**. Kept. |
| **Type what a factory returns** — `return { … }` as a type | astro 80.9 → 80.3, axios 67.6 → 67.2. **Reverted.** |
| **Infer a parameter's type from its call sites** | netron: **0** call sites pass a constructed value, and 2,574 of 2,628 pass the caller's own untyped parameter. **Not attempted** — measured first. |
| **Read a type that points at a declaration** — `T['key']`, `ReturnType<typeof f>` | n8n: 159 receivers typed, and correctly; **+10 edges of 1,123,583**. Headline and floor both unchanged. **Kept** — it reads a declaration and adds no guess — and stated at its true size. |
| **Read `User.prototype.render = …` as a member** | mongoose: 17 members added to its constructor and **0 edges reach any of them**; express floor 91.1% → 83.3%. **Reverted** — the blocker is the CommonJS singleton, not the members. |
| **Let a repository's own `.gitignore` say what its source is** | node-red: 214 → **581 files**, 1,905 → **15,226 edges**. babel, jest, vite and nuxt unchanged. **Kept.** |
| **Read `exports.run = …` as a declaration** | +948 edges across seven repositories for +104 honest misses — mongoose +349, gatsby +313, rollup +257. **Kept.** |
| **Refuse a file packed by a machine** | one repository parsed Yarn's own bundle into **7,996 symbols and 35,526 call sites** in 12.5s; now 156 symbols in 0.1s. rails, discourse and prettier unchanged to the decimal. **Kept.** |

Six of those deserve more than a table row.

**Inferring a parameter's type from its call sites** was proposed here on the strength of one
number: netron reports 20,966 unresolved calls on `reader`, a parameter of `static decode(reader,
position)` that plain JavaScript declares nowhere. If every caller passed the same type, the
parameter would have one.

They do not pass a type at all. Of roughly 2,628 `decode(...)` call sites, **2,574 pass `reader`** --
the caller's own untyped parameter -- and **none passes a constructed value**. The type has no
origin to infer *from*: it is threaded parameter to parameter, and one step of inference reaches
nothing. Making it pay would need transitive propagation to a fixed point, which is a different and
much larger feature -- and at that fixed point the call sites would disagree, because
`flatbuffers.BinaryReader`, `base.BinaryReader` and `protobuf.BinaryReader` all flow into
structurally identical decoders.

There is a second reason it was not built: the extractors record argument expressions for Java
only, and Java declares its parameter types already. The one language that needs this is the one
with no input for it.

**Reading a type that points at a declaration** is the opposite case, and it was built. `INode['parameters']`
and `ReturnType<typeof createDataSource>` do not describe a type; they point at one this index
already holds — the `parameters` member of `INode`, the return annotation of `createDataSource`. So
reading them is a declaration lookup, adds no guess, and cannot lower the floor. It also works:
on n8n it types 159 receivers, and correctly — `INode['parameters']` becomes `INodeParameters`,
`IPollFunctions['helpers']` becomes the four-way intersection that interface really declares, and
`ReturnType<typeof createDataSource>` becomes typeorm's `DataSource`.

Those 159 types are worth **ten edges out of 1,123,583 calls**. The headline stays 77.8%, the floor
stays 64.3%, and indexing takes 121.3s against a 120.9s baseline. A receiver that becomes typed is
usually calling a member that lives in a library anyway, so the call was already booked correctly
as a library call; typing the receiver changes which *proof* is cited, not the count.

The form is also rarer than grepping for it suggests. n8n's sources contain 2,016 indexed accesses,
of which 577 ever reach a receiver that gets called on; directus contains 520 and reaches **none**.
Most sit nested inside a generic, where they are stripped along with it.

Where the rest go was measured too, across six TypeScript repositories:

| | n8n | six repos |
|---|---|---|
| `T['key']` reached a receiver | 577 | 697 |
| …resolved | 116 | 144 |
| …owner not in the index | 423 | 490 |
| …member declared without a type | 38 | 63 |
| `ReturnType<typeof f>` reached a receiver | 2,170 | 2,210 |
| …resolved | 43 | 54 |
| …`f` found, but declaring no return type | 1,292 | 1,294 |
| …`f` not found | 835 | 862 |

Two rows there say not to go further. **328 of n8n's 423 unknown owners are spelled `ReturnType`** —
that is `ReturnType<typeof f>['key']`, the two forms composed, which this does not read. Extending
to it would feed those 328 into the `ReturnType` path, and that path resolves 2% of what it is
given, so the extension is worth single-digit types.

And the reason it resolves 2% is the honest one: **`ReturnType<typeof f>` is what an author writes
precisely because `f` has no written return type.** The annotation is a pointer at the one
declaration that is missing, which is why 1,292 of 2,170 uses find the function and cannot type it.
Reading the pointer cannot conjure the thing pointed at.

**Letting a repository say what its own source is** came out of a sweep over twenty repositories
that had never been indexed, chosen for structural variety rather than score. node-red read 60.4%,
and the reason was not resolution at all: 214 files, **511 symbols**. Its entire product lives in
`packages/node_modules` — 308 of its 541 JavaScript files — and `node_modules` was on a blanket
skip list, so 57% of the repository was invisible.

The repository had already said so, in its own `.gitignore`:

```
node_modules
!packages/node_modules
packages/node_modules/@node-red/editor-client/public
```

Those three lines answer every path correctly, including the re-exclusion on the third. The skip
list was applied afterwards and overruled them. It was applied afterwards for a reason that had
since stopped being true: a dependency tree indexed once as project code and again as an external
declaration used to hit the `files.path` UNIQUE constraint and abort the whole index — and that was
later fixed where it belonged, at the insert, which now says `ON CONFLICT(path) DO NOTHING` and lets
the project's own copy win. The guard outlived the thing it guarded.

An **explicit negation** in the repository's own `.gitignore` now wins, and nothing else does; a
repository that never mentions `build/` still has it skipped. The authority is the right one: git
tracks what you wrote and does not track what you installed.

| node-red | before | after |
|---|---|---|
| files | 214 | **581** |
| symbols | 511 | **16,111** |
| edges | 1,905 | **15,226** |

Its floor fell from 59.8% to 48.1%, and that is the point rather than a cost: the old floor was a
confident number about 37% of a repository. Four other repositories carry the same kind of negation
for test fixtures — babel, jest, vite and nuxt — and all four are unchanged to the decimal.

**Refusing a file packed by a machine** came out of the same sweep, from the opposite signal:
a repository whose 37 files declared **7,996 symbols**. Nobody writes 216 symbols a file. It commits
`.yarn/plugins/*.cjs` — Yarn Berry's own runtime, kept in the tree for reproducible installs — and
2 MB of minified JavaScript became 7,996 symbols and 35,526 call sites. Everything the tool then said
about that repository was about Yarn: `hotspots` and `dead` answered with one-letter names.

A bundle is not source, and line length says so by an order of magnitude in both directions:

| | avg bytes per line |
|---|---|
| express, worst file anybody wrote | 33 |
| angular's currency data table | 302 |
| rails' vendored `clipboard.js` | 1,493 |
| Yarn's plugin bundle | 1,952 |
| a fingerprinted asset in rails' fixtures | 28,241 |

The threshold sits at **1,000 bytes a line**, in the gap, with a 20 KB floor below which being packed
costs nothing anyway. It is counted as `packed` rather than `unparsable`, because the parser could
have taken these and the number should say the difference between a failure and a decision.

react-aptos: **12.5s → 0.1s, 7,996 symbols → 156**, and its figure now describes the project rather
than Yarn. rails loses two files and 180 symbols and reads 74.8% either way; discourse and prettier
do not move at all.

**Reading `exports.run = …`** came out of the same sweep, from one repository that
indexed 92 JavaScript files into fifteen functions. Every one of its command files is written

```js
module.exports.run = async (bot, message, args) => { … };
```

a **named CommonJS export** — the shape of every AWS Lambda handler, Express router module and
Discord command file. `readCommonJs` read `module.exports = View` and nothing else, so none of these
existed. rollup writes 2,240 of them, gatsby 1,464, babel 405, express 45.

It is read during the walk rather than afterwards, because the body has to belong to the new symbol:
handled after the fact, the function exists while every call it makes is booked against the file.

| | symbols | edges | honest misses |
|---|---|---|---|
| mongoose | +51 | **+349** | +7 |
| gatsby | +452 | **+313** | +5 |
| rollup | +32 | **+257** | +1 |
| express | +27 | **+22** | +11 |
| babel | +29 | +4 | +8 |
| eslint | +113 | +3 | +72 |

**+948 edges for +104 misses** — nine links gained per honest miss added. Three headline figures rose
(mongoose 34.1% → 35.0%, gatsby 86.8% → 87.1%, rollup 88.6% → 88.9%), two fell (express 91.4% →
89.5%, eslint 80.0% → 79.7%) and one did not move. The ones that fell are the documented trade: a
name the repository now declares can no longer be **proven** absent from it, so calls correctly
excused as library calls come back into the denominator and some become misses.

The contrast with the experiment below is the whole lesson. Both add declarations nobody was
reading. This one adds declarations the resolver already knows how to reach — `require('./open').run`
is a lookup that has worked all along — and gains 948 edges. That one adds members to a type nothing
is ever typed as, and gains none.

**Reading `User.prototype.render = …`** came out of the same kind of sweep, from mongoose at 34.1%,
and was built and thrown away. `lib/mongoose.js` writes fifty prototype assignments and contributed three
symbols. Reading them gave `Mongoose` seventeen members — and **nothing reached one**: zero edges.
The receiver is never typed as a Mongoose, because the singleton is re-exported through three
CommonJS hops (`module.exports = new Mongoose()`, then two files re-exporting the binding), none of
which is read. Members without that chain only swap one wrong answer for another: mongoose's false
`external:not-in-project` count fell from 126 to 13, which is honest, while its resolution stayed at
34.1% and express's floor fell 91.1% → 83.3%. Half of that change is worse than none — the same
verdict the object-module experiment reached, for the same reason.

The dependency result is worth stating plainly because it contradicts what this file said two
rounds ago. express really does go 72.4% → 91.4% when `node_modules` appears — and express is the
exception, not the rule. A library or framework mostly calls *itself*; installing its dependencies
adds declarations for calls that were already booked as library calls either way.

The factory experiment failed in an instructive direction. Naming the type a function returns adds
member names to the index, and a name the repository declares can no longer be **proven** absent —
so calls that were correctly excused as library calls came back as misses. More symbols, less
proof, lower number. That is the same reason object-module modelling was reverted before it.

What actually blocks the remaining twenty-four is not fixable by engineering:

- **Ruby declares no types.** rails, discourse and solidus are dominated by `ambiguous-name` --
  54,459 of them in rails alone, meaning a receiver that cannot be typed and several methods
  sharing the name. Choosing between them is guessing, and a guess would raise the headline while
  lowering the floor. The language never wrote the declaration.
- **A callback parameter in JavaScript has no type anywhere.** axios reads 76.1% rather than higher
  because its tests are written `startHTTPServer((req, res) => res.end(...))`.
- **Type-level computation is not a call graph.** zod and trpc compute their types with conditional
  and mapped types; `z.string().optional()` has a type that exists only in the checker.

Twelve repositories clear 90% on both columns and nineteen on the headline. Which twelve is the
useful fact: every one of them is a codebase whose receivers are declared where the code can see
them.

### Can `ambiguous-name` be narrowed without guessing? Measured, and mostly no

`ambiguous-name` is a receiver that could not be typed, where several methods share the name. The
obvious narrowing looks like proof rather than a guess: a Java call cannot reach a class the file
neither imports nor shares a package with, so any candidate that is not visible can be struck out.

Measured on dubbo, 714 such calls: **232 had no visible candidate at all**, which would make them
library calls — a third of the bucket, apparently free.

Reading six of them found four correct (`unlock`, `name`, `getCause` — all JDK) and two wrong:

```java
class RandomLoadBalanceTest extends LoadBalanceBaseTest {
    invocation.getMethodName()   // `invocation` is an INHERITED field, typed Invocation
}
```

The subclass never imports `Invocation` because it never names it. The rule would have called that
a library call, and it reaches straight into the repository.

That was not a limit of the rule — it was **a bug the rule would have hidden**. An inherited field
was being typed against the calling file's imports instead of the declaring file's. Fixing it took
the no-visible-candidate group from 232 to 136: **the original number was 41% contamination**, and
a heuristic shipped first would have frozen 96 wrong answers in place.

So the answer is: narrow it by fixing what stopped the receiver being typed, and measure the bucket
again. Two such fixes came out of this one investigation — inherited fields, and `super` in a class
whose `extends` clause Java never wrote down. Both are proof; neither cost a point of floor
anywhere.

### And on ordinary applications, which read higher

The seventeen above are the hardest repositories I could find, not typical ones. Ten of them are
frameworks and platforms — discourse and solidus exist to be extended, typeorm and nest exist to be
called — so they are made of the metaprogramming and generics that static analysis is worst at. An
application that *uses* those frameworks is a much easier read, and the same measurement on real
checkouts says so:

| Project | Stack | Files | In-repo resolution | Floor | Index time |
|---|---|---|---|---|---|
| a Slack bot | TS | 9 | **100%** | 100% | <0.1s |
| a VS Code extension | TS + JS | 60 | **99.4%** | 94.1% | 0.6s |
| a small Rails blog | Rails | 91 | **95.8%** | 87.2% | 0.1s |
| human-essentials | Rails | 1,044 | **93.4%** | 86.0% | 3.6s |
| agenta | Next.js workspace | 3,805 | **89.0%** | 62.5% | 14.5s |

human-essentials is a working Rails application, and it reads **93.4%** — higher than every Rails
repository in the benchmark table, discourse at 78.3% included. Same resolver, same language: the
difference is that one is an app and the other is a platform.

agenta is the one to read carefully, because its floor is 62.5% and almost none of that is guessing
— only 2 of its links rest on a convention. The gap is 5,768 calls on receivers that no declaration
types, which in a React codebase means callback parameters. A codebase written that way will have a
low floor no matter what is installed, and it is better to know that than to be told a number.

**`provenlens doctor` answers this for a repository you have rather than one in a table.** It reads
the index against the machine and says what is missing, because the figure alone cannot tell a weak
resolver from an uninstalled project:

```
$ provenlens doctor
reading: 72.4% of the calls that could be in this repo

[MISSING] no node_modules anywhere in the tree, and the code imports 373 package(s)
  why: a chain through a library stops at the library, and everything past it is a miss
  fix: npm install   (or yarn / pnpm install, whichever this project uses)
```

That is express, whose source is unchanged between 72.4% and 91.4%. For Ruby the same command says
the opposite — that nothing can be installed to change the answer, because the language declares no
types — so no one spends an afternoon looking for a package that was never going to exist.

### What is still missed, and why

**A receiver typed only by a dependency.** `contextRunner.run(context -> context.getBean(...))`
types `context` from Spring Boot's signature; `Mono<T>` types halo's reactive chains from Reactor's.
Everything downstream of such a receiver used to be unresolvable.

For TypeScript and JavaScript it no longer is: provenlens **reads the `.d.ts` files of the packages a
project imports**, so a chain can be typed through a library instead of stopping at one. Those
files are marked external — never a resolution target, never in a search or a count — and a call
landing on one is booked as a library call named after its package, proven by the declaration
rather than assumed from a name.

Measured both ways — with the dependencies installed, and again with `node_modules` moved out of
the tree — this turns out to decide most of the number:

| | without `node_modules` | with |
|---|---|---|
| express | 72.4% / floor 49.0% | **91.4% / 91.1%** |
| nest | 56.1% / floor 40.3% | **84.8% / 79.5%** |
| axios | 60.5% / floor 45.6% | **66.8% / 56.1%** |

An earlier pass put this effect at a point or two. That was true of the resolver as it stood then,
which could do little with a declaration once it had it: reading `EntityManager` off a field is
worth nothing until something can walk `dataSource.manager.save`. The two arrived together, and the
floors moved further than the headlines did — which is the shape of a guess being replaced by a
fact rather than a number going up.

**Java no longer stops at the JAR either.** Signatures are read with `javap`, which ships with
every JDK and prints return types, parameter types and generic arguments as text — decoding class
files directly would be a great deal of work to learn the same facts. The JDK's own classes need no
download at all, and that is most of what it is worth: `Optional`, `List` and `CompletableFuture`
stop being assumptions and become proofs, which is why the Java floors moved further than the
headlines did.

One approximation is worth naming. `List<E>.stream()` is declared to return `Stream<E>` — a type
variable, not a type. Substituting type parameters properly means tracking them through a whole
signature; what a container method does in practice is hand its element along, so the receiver's
element type is used instead. It is guarded to names that actually look like a variable, so a real
type that simply is not indexed stays unknown rather than borrowing one.

**A receiver built by an expression, not named by one.** A path of fields is walked —
`dataSource.manager.save(...)` types `manager` from `DataSource`'s declaration of it, and a
variable assigned such a path is typed the same way. What is not walked is everything else an
expression can be: an index into an array, a destructuring pattern, a ternary, a value returned
through a callback. This is now the largest remaining bucket by a wide margin — 3,930 of typeorm's
misses, against 62 for the next reason down — and it is a long tail rather than one missing rule,
which is why the fixes above bought whole points and the next ones will not.

**A JDK class the project shadows — fixed, and the shape of the fix is the point.** spring-boot
declares a nested class called `System`, and 368 `System.getProperty` calls across the repository
used to resolve to it rather than to `java.lang.System`; jackson-databind had the same bug on
`Double`. Precedence was only half of it: the language's implicit import outranks "some class
somewhere shares the name", but that rule cannot fire until `java.lang.System` is actually in the
index, and it was not — javap is asked about the types the code *declares*, and `System` appears
only as the receiver of a static call.

Deriving the missing names from the source was tried in four arrangements and all four were
reverted. Reading every capitalised receiver as a java.lang candidate competes for the same capped
budget as the imports that genuinely need reading, and the imports are worth more: jenkins lost 350
proven library calls, which became 321 misses and 39 guesses. What works is the unglamorous version
— a fixed list of ~40 java.lang names, appended *after* the cap so it can never displace an import.
java.lang is a closed, stable API; asking about all of it costs one javap batch. spring-boot went
84.4% → 84.9% (floor 83.5% → 84.0%), the mistaken `.System` bucket 368 → 0, and across all 43
repositories nothing else moved except quarkus, whose headline fell 0.1 while its floor rose 0.1 —
guesses turning into proofs, which is the trade this project is built to take.

**A union of two real types, refused rather than answered.** `render: StoryRender<TRenderer> |
CsfDocsRender<TRenderer> | MdxDocsRender<TRenderer>` is storybook saying the value is one of three,
and `render?.teardown?.()` may be reaching any of them. The generic strip used to cut at the first
`<` and take the rest of the type with it, so the union was silently answered with its left
operand: a link that looks proven and was chosen by position. Stripping the brackets in balance
instead lets the refusal already written here actually fire. It costs storybook 0.1 and immich's
floor 0.1, and both are worth paying.

An intersection is the opposite case and is now resolved rather than refused. `DirectusClient<
unknown> & RestClient<unknown>` says the value has every member of both, which is *more* than
either name states alone, so it is modelled as a type inheriting from all of them and the member
walk looks through each in turn: directus 77.7% → 78.3%, floor 68.0% → 68.5%.

**A receiver nothing declares at all.** A method parameter in a dynamically typed language names no
type anywhere, so `def deliver(recipient)` gives the resolver the name and nothing else. That is why
the naming convention exists, why it is capped at 0.5, and why it is struck out of the floor. It is
also why mastodon and rubygems.org read ~88% with floors near 80%: roughly 6% of their links rest on
a convention. No amount of engineering turns that into a declaration, because Ruby never wrote one.

## Commands

| Command | What it does |
|---|---|
| `provenlens init [path]` | Create `.provenlens/` and build the index for the first time |
| `provenlens sync [-w]` | Reparse changed files; `-w` keeps watching |
| `provenlens index` | Rebuild everything |
| `provenlens status` | Coverage, resolution quality, binding counts |
| `provenlens doctor` | **Why this repo reads as it does, and what would change it** — checks dependencies, JDK and jars against what the code imports |
| `provenlens query <name>` | Find symbols by name |
| `provenlens explore <name>` | Source + call paths + bindings + blast radius, in one shot |
| `provenlens node <name>` | One symbol in full, with callers and callees |
| `provenlens callers <name>` / `callees <name>` | One direction of the relationship |
| `provenlens impact <name>` | Blast radius |
| `provenlens why <name>` | **Which of this symbol's links rest on a declaration, and which on a convention** — plus the calls it makes that never resolved |
| `provenlens hotspots` | **What the most other code depends on** — read this before changing anything |
| `provenlens dead [--public]` | Methods nothing reaches, with framework entry points and template-named symbols already ruled out |
| `provenlens cycles` | Files that depend on each other, directly or the long way round |
| `provenlens routes [-m <text>]` | **Every HTTP route the repo serves and who calls it** — Spring, NestJS, Express and Rails |
| `provenlens path <from> <to>` | **Shortest directed chain** between two symbols, hop by hop — across repositories when a binding bridges them |
| `provenlens affected [files...] [--fail-if-untested]` | What changed files reach, and **which tests already cover it**; the flag exits 2 when nothing does — a CI gate |
| `provenlens export [name] [-f json\|mermaid]` | The graph around a symbol as JSON or a **Mermaid diagram** ready for a README or PR |
| `provenlens install [target]` | Register the MCP server with an agent (`--dry-run` to preview) |
| `provenlens uninit [path]` | Remove the index from a project |
| `provenlens serve [paths...] [-p 7777] [-o] [--new-token]` | **Web UI** — search and browse the graph, one repo or **many at once** |
| `provenlens mcp [path]` | MCP server over stdio |

`query`, `callers`, `callees`, `impact`, `path`, `export` and `affected` all accept `--json` for
piping into other tools.

### Three questions a search cannot answer

**`hotspots` — what would hurt most to change.** Not the biggest class: the one the most other
code depends on. A class that calls a hundred things is large; a method a hundred things call is
load-bearing, and the two are ranked oppositely.

```
 callers   files  symbol
      18       8  org.springframework.samples.petclinic.owner.OwnerRepository#findById
                  src/main/java/.../OwnerRepository.java:60
```

**`dead` — what nothing reaches.** This one is built to be *wrong in the safe direction*, because
the cost of a false positive is a deleted function:

- Framework entry points are excluded outright. Nothing calls a `@Scheduled` method, and deleting
  it takes the job with it.
- **Templates and config are read as plain text**, and the words in them rule symbols out.
  petclinic's `getAddress`, `getCity` and `getTelephone` each look unreached, and each is called by
  `${owner.address}` in a Thymeleaf page. All three are correctly absent.
- Public and exported names are held back by default. sinatra has 225 with no caller inside itself
  and every one is a working API, so the command says *"nothing certain, 225 held back"* rather
  than printing them as suspects. `--public` shows them.
- **Every report prints how many calls went unresolved**, because an unresolved call is
  indistinguishable from no call, and the list is worth exactly what that number says.

**`cycles` — what depends on itself the long way round.** Between *files*, which is the level a
dependency cycle is actually felt at: two modules that each import the other cannot be understood,
tested, or extracted separately. Method recursion is normal and is not reported.

### `routes` — the URL is a string on both sides

A controller declares `@GetMapping("/orders/{id}")`; something, frequently in another repository,
calls `GET /orders/42`. No call graph crosses that gap — it is a string at each end — which is the
same shape as an SQS queue name, so it is the same kind of plugin.

```
$ provenlens routes -m owners
GET /owners/{}
  served by  org.springframework.samples.petclinic.owner.OwnerController#showOwner
             src/main/java/.../OwnerController.java:180
```

Four routing styles are read, covering the languages this tool supports:

| | Recognised |
|---|---|
| **Spring** | `@GetMapping`/`@PostMapping`/…, `@RequestMapping` with its verb, class-level prefix joined on |
| **NestJS** | `@Controller('albums')` + `@Get(':id')`, prefix joined — 170 routes in immich |
| **Express** | `app.get('/x', handler)`, `router.post(…)`, only where a handler is actually registered |
| **Rails** | `config/routes.rb`, including `resources :orders` expanded to the six routes it means |

Consumers are HTTP clients that name a path — `RestTemplate`, `WebClient`, `axios`, `fetch`. The
key is the pair `METHOD /path`, and a parameter is normalised so `{id}`, `:id`, `<int:id>` and the
`42` a caller actually wrote are all one route. Anything computed — a path built from a config
placeholder — is left out rather than guessed at.

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
provenlens serve --open
```

**Several repositories at once.** Point it at a folder holding multiple services and it finds every
initialised repo inside:

```bash
provenlens serve ~/work/services --open
```

Or list them explicitly: `provenlens serve ./order-service ./notify-service`.

The toolbar has a repository dropdown — **"All repos" shows every one of them**, picking one
narrows the view to it. Clicking a repository's hub on the canvas moves the dropdown too, so the
two never disagree about what you are looking at. Each repo gets its own hue, drawn as a **ring
around the node** so it never fights the symbol-kind colour; while the view is scoped, the dropdown
wears that same hue.

**Cross-repo edges.** This is the actual reason to open several repos at once: an SQS producer in
one service and its listener in another are connected only by **the queue name**, with no call
between them. provenlens matches binding endpoints across the separate indexes and draws them as
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
symbols and draws just that chain — the same walk `provenlens path` does, bindings and all.

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
  `$XDG_STATE_HOME/provenlens/ui-token` (mode 0600) and reused across restarts, so the URL stays
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
git diff --name-only | provenlens affected
```

That returns which symbols changed, what reaches them, and **which existing tests cover them** — in
other words, the list of tests to re-run. On spring-petclinic, touching `Owner.java` produces 18
relevant tests.

As a pre-push gate, `--fail-if-untested` exits 2 when the diff touches production code that no
existing test reaches:

```bash
git diff --name-only | provenlens affected --fail-if-untested
```

## Using it from Claude Code

```bash
provenlens install claude-user
```

It prints the change before writing and always keeps a `.bak`. Targets are `claude-user`,
`claude-project` and `cursor`. Or do it by hand:

```bash
claude mcp add provenlens -- node ~/AI-TOOL/provenlens/bin/provenlens.js mcp
```

Five tools: `provenlens_explore`, `provenlens_why`, `provenlens_impact`, `provenlens_affected`,
`provenlens_status`. Each
takes a `projectPath`, so **one server serves every repository** — and a `projectPath` naming a
folder of checkouts serves them **all at once**, each answer labelled with the repository it came
from. Indexes stay current through the file watcher.

`provenlens install` only auto-detects agents that already have a config file. The project-scoped
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

261 tests across six fixture suites plus regression, security and multi-repo coverage:

| Fixture | Simulates | The chain grep cannot follow |
|---|---|---|
| `java` | Spring: Controller → Service interface → Impl → Repository interface | DI across two interface layers, plus same-arity overloads |
| `ruby` | Rails: model, concern, service object, controller | `donor.name` — `donor` generated by `belongs_to`, `name` by `attr_reader` |
| `ts` | TS + JS: barrel files, tsconfig aliases, constructor DI | an import through `export *` before reaching the real class |
| `bindings` | MyBatis, Camel, SQS, Kafka, Spring events, GraphQL, gRPC, Flyway | a Java producer → a Ruby Shoryuken worker, matched on queue name |
| `vendored` | A repository that keeps its own source inside `packages/node_modules` | that the directory a project's `.gitignore` puts back is source, and a tree re-excluded after it is not |
| all of `__fixtures__` | One repo containing all four languages | resolvers not wiping each other's graphs |

`test/regressions.test.js` locks down every bug that has been fixed: LIKE wildcards, scoring order,
duplicate edge collapsing, file accounting on sync, the watcher's ignore rules, test detection, and
empty / syntactically broken / Vietnamese-and-emoji files.

The tests assert that the Java and Ruby fixtures have **zero misses**, and that everything else is
attributed to the right library. If a resolver later drops an internal call, a test goes red.

## In continuous integration

The blast radius of a pull request, from the call graph rather than a text search:

```yaml
- uses: actions/checkout@v7
  with: { fetch-depth: 0 }   # the merge-base has to be in the clone
- uses: NamHT4Devlop/provenlens@v1
```

It writes to the job summary, which every run can write — including a pull
request from a fork, which gets a read-only token and no secrets. Nothing here
reads one. A repository that wants the report as a comment posts it itself from
the `report` output, where the permission to do so is its own decision.

`fail-if-untested` is off by default. A change that no existing test reaches is
worth *seeing*; whether that should stop a merge is a judgement a repository
makes on purpose, not one it inherits by installing an action.

## Prior art

None of the ideas here are new, and it is worth saying where they come from rather than leaving a
reader to wonder.

| | What it does | Where this differs |
|---|---|---|
| **ctags** (1992), **cscope** | Index symbols; cscope answers "who calls this" | Both index names. Neither resolves a *receiver's type*, which is where most of the work below goes |
| **LSP** call hierarchy | Exact, from a real compiler frontend | A language server needs the project to build, and answers one file at a time. This runs on a checkout that may not compile, across four languages at once |
| **Kythe**, **Sourcegraph**, **Glean** | Cross-repository code graphs at scale | Those are services with infrastructure behind them. This is a SQLite file in the repository, offline, with no build step |
| **codegraph** | The same shape of problem — a call graph for AI agents | Solves it with a Rust kernel and a compiled TypeScript CLI, and reports telemetry. This is plain JavaScript on WASM grammars, four dependencies, and nothing leaves the machine — a Security check asserts that on every push |
| **tree-sitter** | The parsers | Not an alternative; this is built on it |

The command vocabulary is deliberately the field's own. `callers`, `callees`, `index`, `query` and
`status` mean here what they have meant since cscope, and renaming them to be different would cost
a reader more than it gained.

What is not borrowed is the accounting: two numbers rather than one, guesses struck out of the
floor, and a table of the changes that were reverted for raising the first number while lowering
the second.

## Known limits

- **A receiver typed only by a gem.** TypeScript, JavaScript and Java are all handled now — `.d.ts`
  for the first two, `javap` signatures for the third — but Ruby has no declarations to read at
  all, which is why the Rails rows have the widest gap between headline and floor.
- **Generic substitution is approximate.** A type variable in a library's return type is filled
  from the receiver's element type rather than by real inference; it is right for container methods
  and gives up rather than guess elsewhere.
- **A callback parameter in JavaScript** is the sharpest form of that. `startHTTPServer((req, res)
  => res.end(...))` says nothing about `res` anywhere, and neither does the helper it is passed to.
  Reported as a miss rather than guessed, which is most of what axios still misses at 76.1%.
- **Node object-modules** — `var app = module.exports = {}` then `app.set = function(){}` — are not
  modelled, so their members look external. Modelling them is correct in principle: express really
  does define `res.send`. It is left out because without a way to type the `req`/`res` parameters
  that receive them it turns ~900 express calls from proven-library into unresolvable, taking the
  repo from 91% to 29%. Half of that change is worse than none.
- **Resolution is an in-memory algorithm, and very large repositories cost real memory.** A chained
  call is answered by looking up the ref its receiver came from, so every ref stays resident.
  google-cloud-ruby — 31,023 Ruby files, 4.0M call sites — needs 7.3 GB, past V8's ~4 GB default
  cap. `init`, `index` and `sync` now re-exec with half of physical memory (clamped to 4–16 GB), so
  the ceiling is the machine rather than V8; on a small machine a repository that size will still
  not fit. Two of 5,000 repositories reached it.
- **Windows is in the matrix and reports on every pull request; it does not gate one**, because
  claiming green would be worse than saying otherwise. This entry used to blame `multirepo`'s
  teardown for closing a server and then removing the workspace. That was a guess, and it was
  wrong. The runner log says what actually happened:

      Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72

  Every test in the file passed and then the process aborted -- not a JavaScript error but an
  assertion inside libuv, which `fs.watch` fails when the path it was handed and the path Windows
  reports for an event are written differently. `os.tmpdir()` on a runner is
  `C:\Users\RUNNER~1\AppData\Local\Temp`, an 8.3 short name, and the events come back long. The
  watcher now resolves its root with `realpathSync.native` first. That is a fix to the tool, not to
  the test: `provenlens serve` on any such path aborted the same way.
- **On Windows the index and the UI token are not protected by file permissions.** `.provenlens/`
  is created `0700` and the UI token `0600`, which Windows does not have: it carries ACLs, and Node's
  `mode` there means nothing. The index holds your source's structure and the token opens the local
  UI, so on a shared Windows machine both inherit whatever the parent directory allows. Nothing
  else about the tool differs.
- **The Ruby inflector** is simple and does not handle irregulars (`people`/`person`).
- **Annotation-style MyBatis** (`@Select` on the method) needs no binding — the SQL is already in
  the method.
- **NestJS token DI** (`{ provide: 'X', useClass: Y }` matched to `@Inject('X')`) needs
  object-literal extraction the TS extractor does not do yet; decorators themselves are recorded.
- **A type spelled by composing two pointers** — `ReturnType<typeof useStore>['items']` — is not
  read. Each half is, separately. The composition is n8n's largest single reason an indexed access
  fails to resolve (328 of 423), and it is left out because the `ReturnType` half resolves 2% of
  what reaches it, so composing them buys single-digit types.

## Roadmap

- [ ] NestJS custom-provider tokens as a binding plugin (needs object-literal extraction)
- [x] Read `.d.ts` from `node_modules` and signatures from JARs, to keep a chain alive past a
      library hop. Done — see *Optional: install the project's dependencies* above.

      This item used to claim it was "the single change that would move halo, spring-cloud-aws,
      nest and typeorm". That claim is **wrong**, and measuring it is what showed it: nest and
      typeorm already have their dependencies on disk, and installing zod's changed its figure by
      **0.0 points**. A prediction about what a fix is worth is not evidence, which is the rule the
      rest of this README is written to and the one this line broke.

- [ ] **Type a chained receiver.** This is what actually separates the sub-90 repositories from the
      rest. `complex-receiver-chain` is 97.8% of zod's misses, 99.3% of trpc's and 98.8% of
      astro's: `a.b().c().d()` where some link in the chain has no declared type. In the Ruby
      repositories the equivalent is `ambiguous-name` (116373 of discourse's misses), and that one
      is the language rather than the resolver — Ruby declares nothing to walk.

      No estimate of what fixing it would be worth is given here on purpose. It will be measured.

## License

MIT — see [`LICENSE`](LICENSE). The four runtime dependencies are MIT (`commander`, `ignore`,
`web-tree-sitter`) and Unlicense (`tree-sitter-wasms`, which bundles the grammars under their own
permissive licenses). No copyleft anywhere in the tree, and `yarn list` shows no transitive
dependencies to audit beyond those four.

