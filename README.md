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

### 5b. Optional — install the project's dependencies

codelens reads type declarations from a project's dependencies, so a call chain
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
codelens status
```

```
dependencies read: 15 package(s); 285 declaration file(s), 312 jvm type(s)
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

Forty-three repositories, none of them chosen for its score. They were added in four rounds, each
named in advance, and each round pulled the median down: the first eleven sat at 91.4%, and all
forty-three bring it to 88.5%. That is what picking before measuring costs, and it is the only way
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

nest, typeorm and axios have their `node_modules` present and read **90.9%, 88.2% and 67.6%**. So
a dependency tree is not what separates these repositories from 90%.

| Repo | Stack | In-repo resolution | Floor if every assumption were wrong |
|---|---|---|---|
| spring-petclinic | Spring Boot + Data, 51 files | **99.7%** | **98.6%** |
| mall | Spring Boot + MyBatis, 630 files | **99.4%** | **99.3%** |
| mybatis spring-boot-starter | MyBatis, 154 files | **98.5%** | **98.5%** |
| TheAlgorithms/Java | plain Java, 1588 files | **98.0%** | **97.5%** |
| nx | TS monorepo, 5305 files | **95.4%** | 89.3% |
| camel-spring-boot-examples | ~50 Camel examples, 325 files | **95.2%** | **94.7%** |
| mybatis jpetstore | MyBatis + Flyway, 43 files | **95.1%** | **95.1%** |
| devise | Rails engine, Ruby | **94.4%** | 85.0% |
| google/guava | Java, Maven | **94.3%** | **93.7%** |
| vuejs/core | TS pnpm workspace, 527 files | **93.9%** | 86.8% |
| spring-framework | Gradle multi-module, 9901 files | **93.1%** | **91.5%** |
| apache/dubbo | Maven multi-module, 4190 files | **93.0%** | **91.5%** |
| date-fns | JS, monorepo | **92.9%** | 83.5% |
| jenkins | Java, Maven | **92.4%** | **90.2%** |
| apache/kafka | Gradle multi-module, 6196 files | **92.3%** | **91.0%** |
| express | plain JS, 141 files | **91.4%** | **91.1%** |
| java-design-patterns | Java, 1991 files | **91.4%** | 89.6% |
| immich | NestJS + Svelte monorepo | **91.4%** | 85.2% |
| nest | TS, 1904 files | **90.9%** | 86.8% |
| puma | Ruby | **89.1%** | 77.8% |
| micronaut-core | Java, Gradle | **88.6%** | 86.1% |
| sinatra | Ruby, 147 files | **88.5%** | 81.3% |
| typeorm | TS, 3575 files | **88.2%** | 82.5% |
| spring-cloud-aws | Java, 816 files | **88.2%** | 86.9% |
| rubygems.org | Rails, 1392 files | **88.1%** | 80.4% |
| mastodon | Rails + TS, 4199 files | **87.6%** | 80.1% |
| halo | Java + TS, 2228 files | **87.6%** | 85.4% |
| prettier | JS + TS, 5762 files | **87.6%** | 68.3% |
| storybook | TS monorepo | **87.3%** | 74.8% |
| medusa | TS monorepo | **87.3%** | 74.1% |
| fastlane | Ruby, 1340 files | **86.7%** | 77.4% |
| sidekiq | Ruby | **85.9%** | 79.7% |
| quarkus | Java, Maven multi-module | **85.0%** | 81.9% |
| jekyll | Ruby, 171 files | **84.5%** | 75.0% |
| solidus | Rails, 2329 files | **83.5%** | 74.8% |
| svelte | JS + TS monorepo | **82.4%** | 68.9% |
| redmine | Rails app | **81.4%** | 72.7% |
| astro | TS monorepo | **80.9%** | 68.9% |
| trpc | TS monorepo | **80.1%** | 73.9% |
| discourse | Rails, 14358 files | **78.6%** | 72.7% |
| zod | TS pnpm workspace | **75.7%** | 62.1% |
| rails | Rails framework | **74.8%** | 62.5% |
| axios | JS, 242 files | **67.6%** | 56.9% |

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
  immich from 68.5% to 91.4%, trpc from 60.1% to 80.1%.
  What is left is the part reading cannot fix: a signature like `Flux<T>.map(Function<T,R>)`
  answers with type *variables*, and substituting them properly is a different job from reading
  them.
- Types declared **nowhere** — Ruby, and JavaScript callbacks. `axios` is the clearest case in the
  table: its tests are written as `startHTTPServer((req, res) => res.end(...))`, and nothing in
  JavaScript ever says what `res` is. 67.6% is the honest reading of that, not a defect.

**Two numbers, and the second is the one that keeps the first honest.** The floor assumes every
judgement the resolver made without a declaration behind it was wrong — both directions. Calls
excused as runtime built-ins come back into the denominator, *and* every link resting on a
convention rather than a declaration is struck off the top: `name-convention`, `unique-name`,
`method-missing`. That second half was added in 2026-08-23, because an assumption that **resolves**
a call flatters the headline exactly as much as one that excuses it, and counting only the latter
made the self-audit a half-audit. `bench` prints the guessed links so the gap is inspectable.

Read the two columns together. spring-petclinic is 99.7% on one guessed link in the whole repo.
axios is 67.6% on a floor of 56.9% — plain JS annotates nothing, so a tenth of what it *does* link
rests on a convention rather than a declaration. mastodon and rubygems.org sit near 88% with floors
near 80%, which is what Rails looks like when half the receivers are named after their model and
nothing else says so.

The graph grew far more than the percentages did: halo went from 26,654 edges to 36,154, mastodon
from 21,748 to 27,634, rubygems.org from 10,253 to 13,052. Several numbers *fell* along the way and
were kept — when Lombok members and `delegate` forwards entered the index, names that had been
**proven** to live outside the repo no longer were, so the denominator grew and honest new misses
appeared with it. Lower number, more complete graph, every time.

Re-measure any time with `./scripts/bench.js <repo> --detail`, which prints the miss buckets and
the guessed links as well as the two headline figures.

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

**`codelens doctor` answers this for a repository you have rather than one in a table.** It reads
the index against the machine and says what is missing, because the figure alone cannot tell a weak
resolver from an uninstalled project:

```
$ codelens doctor
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

For TypeScript and JavaScript it no longer is: codelens **reads the `.d.ts` files of the packages a
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
| `codelens doctor` | **Why this repo reads as it does, and what would change it** — checks dependencies, JDK and jars against what the code imports |
| `codelens query <name>` | Find symbols by name |
| `codelens explore <name>` | Source + call paths + bindings + blast radius, in one shot |
| `codelens node <name>` | One symbol in full, with callers and callees |
| `codelens callers <name>` / `callees <name>` | One direction of the relationship |
| `codelens impact <name>` | Blast radius |
| `codelens hotspots` | **What the most other code depends on** — read this before changing anything |
| `codelens dead [--public]` | Methods nothing reaches, with framework entry points and template-named symbols already ruled out |
| `codelens cycles` | Files that depend on each other, directly or the long way round |
| `codelens path <from> <to>` | **Shortest directed chain** between two symbols, hop by hop — across repositories when a binding bridges them |
| `codelens affected [files...] [--fail-if-untested]` | What changed files reach, and **which tests already cover it**; the flag exits 2 when nothing does — a CI gate |
| `codelens export [name] [-f json\|mermaid]` | The graph around a symbol as JSON or a **Mermaid diagram** ready for a README or PR |
| `codelens install [target]` | Register the MCP server with an agent (`--dry-run` to preview) |
| `codelens uninit [path]` | Remove the index from a project |
| `codelens serve [paths...] [-p 7777] [-o] [--new-token]` | **Web UI** — search and browse the graph, one repo or **many at once** |
| `codelens mcp [path]` | MCP server over stdio |

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

198 tests across five fixture suites plus regression, security and multi-repo coverage:

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

- **A receiver typed only by a gem.** TypeScript, JavaScript and Java are all handled now — `.d.ts`
  for the first two, `javap` signatures for the third — but Ruby has no declarations to read at
  all, which is why the Rails rows have the widest gap between headline and floor.
- **Generic substitution is approximate.** A type variable in a library's return type is filled
  from the receiver's element type rather than by real inference; it is right for container methods
  and gives up rather than guess elsewhere.
- **A callback parameter in JavaScript** is the sharpest form of that. `startHTTPServer((req, res)
  => res.end(...))` says nothing about `res` anywhere, and neither does the helper it is passed to.
  Reported as a miss rather than guessed, which is most of why axios reads 67.6%.
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

