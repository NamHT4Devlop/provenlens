# Setting up provenlens, step by step

*Bản tiếng Việt: [SETUP.vi.md](SETUP.vi.md).*

This is the guide to read if you have never used provenlens and want it working on your machine.
Every step says what to type, what you should see, and what to do when you do not see it. Nothing
here needs a compiler, a database server, an account or a network connection after the install.
Ten minutes on a normal laptop.

What you will have at the end: a command, `provenlens`, that builds a call graph of any Java, Ruby,
TypeScript or JavaScript repository and answers *who calls this, what does this call, what breaks
if I change it, which tests already cover it* -- and, if you use Claude Code, an agent that gets
those answers on its own.

---

## Step 1 -- Check what your machine has

Open a terminal and run:

```bash
node -v
```

**You should see** `v22.x.x` or higher (`v24.13.0` is what this guide was written on).

**If not:** provenlens needs Node 22 or newer because it uses `node:sqlite`, which only exists
from 22. Install the current LTS from <https://nodejs.org> or, if you use nvm, `nvm install 22`.
Anything older fails at the first command with `Cannot find module 'node:sqlite'`.

```bash
yarn --version
```

**You should see** `1.22.x`. This project is set up for Yarn 1 (Classic).

**If not:**

```bash
npm install -g yarn
```

```bash
git --version
```

**You should see** any version. provenlens asks git which files belong to a repository, so it
must be present; almost every machine has it.

Optional, for Java repositories only:

```bash
javap -version
```

**You should see** a JDK version (`21.0.2` here). javap lets provenlens read the JDK and your
dependency jars, which turns "I assume this is a library call" into "this is `java.io.PrintStream`".
Without it everything still works; Java answers are just less certain. Any JDK 11+ provides it.

---

## Step 2 -- Get the code and install its four dependencies

```bash
git clone https://github.com/NamHT4Devlop/provenlens.git ~/provenlens
```

```bash
cd ~/provenlens && yarn install
```

**You should see** yarn finish with `Done in Ns.` and no errors. It installs exactly four
packages -- `commander`, `ignore`, `web-tree-sitter`, `tree-sitter-wasms` -- and nothing under
them. Each is pinned to an exact version; the lockfile is committed, so you get the same bytes
the benchmarks in the README were measured with.

**If** yarn warns about the Node version, read Step 1 again. **If** it stops on
`web-tree-sitter`, do not upgrade it: 0.26 and 0.27 cannot load the grammars this ships with (see
*Pinned versions* in the README). `yarn install --frozen-lockfile` restores the pinned pair.

You can put the clone anywhere. The rest of this guide assumes `~/provenlens`; substitute your
path if you chose another.

---

## Step 3 -- Make `provenlens` a command

**macOS and Linux:**

```bash
mkdir -p ~/.local/bin && ln -sf ~/provenlens/bin/provenlens.js ~/.local/bin/provenlens
```

```bash
provenlens --version
```

**You should see** `0.1.0`.

**If you see** `command not found`: `~/.local/bin` is not on your PATH. Add it and reopen the
terminal (or `source` the file):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

(Use `~/.bashrc` if your shell is bash.) Why a symlink and not `npm link` or `yarn link`: those
install into the bin directory of the Node version you happen to be running, so switching Node
versions makes the command silently disappear. A symlink into `~/.local/bin` survives that.

**If you see** a line like `ExperimentalWarning: SQLite is an experimental feature`: you ran
`node ~/provenlens/bin/provenlens.js` directly. Through the symlink the warning is switched off;
if you must call node yourself, add `--no-warnings`.

**Windows:** there is no symlink step. Either run every command as
`node C:\path\to\provenlens\bin\provenlens.js ...`, or create a file `provenlens.cmd` somewhere on
your PATH containing exactly:

```
@node --no-warnings "C:\path\to\provenlens\bin\provenlens.js" %*
```

---

## Step 4 -- Keep the index out of every repository, once

provenlens writes its index into a folder called `.provenlens/` at the root of each repository you
index. It is a cache: safe to delete, rebuilt on demand, and it must never be committed --
especially not into a team repository. Tell git to ignore it everywhere, once:

```bash
echo '.provenlens/' >> "$(git config --global core.excludesfile || echo ~/.config/git/ignore)"
```

Check it took:

```bash
cd /path/to/any/git/repo && git check-ignore -v .provenlens/
```

**You should see** a line naming your global excludes file and the `.provenlens/` pattern.

**If you see nothing:** git has no global excludes file configured, and the `echo` above wrote
to `~/.config/git/ignore`, which git only reads when `core.excludesfile` is unset *and* that path
exists. Tell git about it explicitly:

```bash
git config --global core.excludesfile ~/.config/git/ignore
```

---

## Step 5 -- Index your first repository

Go to a repository written in Java, Ruby, TypeScript or JavaScript and build its index:

```bash
cd /path/to/your/repo && provenlens init .
```

**You should see** something like this (a small Spring project):

```
created .provenlens/ in /path/to/your/repo
indexed 41 file(s), 312 symbol(s)
java: 421 direct, 38 via impl, 3 by name, 12 missed, 640 library (97.5% of in-repo calls linked)
http: 9 provider(s), 2 consumer(s), 2 wired
```

The line per language is the resolver's own report card: how many calls it linked to a
declaration in this repository (`direct`, `via impl`), how many it linked by a naming convention
(`by name`), how many it could not place (`missed`), and how many go into a library, which are not
misses. The percentage counts only calls that *could* have landed in this repository.

**How long it takes:** a few hundred files per second. A 2,000-file project is done in under ten
seconds; a 25,000-file monolith takes about a minute and a half. The first run on a Java repository
also spends a second or two on javap.

**If you see** `N file(s) refused as machine-packed`: those are minified bundles or generated
files, and refusing them is correct -- they are not source and would inflate every number.

**If you see** a language listed under `discovered but not parsed`: it is one of the languages
provenlens does not cover (Python, Go, C#...). Files in the four covered languages are still
indexed.

---

## Step 6 -- Check what the index is worth

```bash
provenlens status
```

**You should see** the counts and one line that matters most:

```
resolution: 93.4% of the calls that could be in this repo
```

Read that number before trusting anything else. Above 90% on Java or TypeScript is normal; Ruby
and plain JavaScript sit lower because those languages do not declare types, and the README's
*Reading the numbers honestly* section says exactly what to expect and why.

```bash
provenlens doctor
```

**You should see** a list of findings, each with a `why` and a `fix`, then a tally of what the
remaining misses are. `[MISSING]` means a dependency is not installed and installing it would
raise the number; `[INHERENT]` means the language itself is the limit and nothing to install will
change it. The most common fix is simply the project's own dependency install:

```bash
npm install
```

for a JavaScript or TypeScript project (`pnpm install` / `yarn install` as the project uses), or a
build that downloads jars for Java (`mvn dependency:resolve`, `./gradlew dependencies`). Then:

```bash
provenlens index
```

to rebuild, and `provenlens status` again. The number is measured, never predicted; on some
repositories installing everything changes nothing, and `doctor` will say so.

---

## Step 7 -- Ask it something

The one command to remember:

```bash
provenlens explore "SomeClassOrMethodName"
```

**You should see** the matching symbols' real source with line numbers, then for each: *Callers*,
*Calls out to*, framework wiring if any, and the blast radius. Under *Callers* there may be a
section headed **Unlinked call sites named `x`** -- calls that share the name but which the graph
could not link to anything, with file and line. Those are places to read, not callers; the graph
never guesses, and this list is how it stops a guess from being needed.

The narrower questions:

```bash
provenlens callers "Type#method"
```

```bash
provenlens impact "Type#method"
```

```bash
provenlens affected src/some/file.rb
```

`callers` is who calls it. `impact` is everything that transitively reaches it. `affected` takes
changed files -- or `git diff --name-only | provenlens affected` -- and answers which tests already
cover the change. If a name matches several symbols the command stops and lists them; re-run with
the `Type#method` spelling it shows.

Two more worth knowing: `provenlens why "Type#method"` says which of a symbol's links rest on a
declaration and which on a convention, and `provenlens dead` lists methods nothing reaches, built
to be wrong only in the safe direction. The full list is under *Commands* in the README.

---

## Step 8 -- Keep the index fresh

The index is as of the last time it was built. After editing, bring it up to date:

```bash
provenlens sync
```

Only files whose contents changed are re-read. To have that happen on its own while you work:

```bash
provenlens sync -w
```

leaves a watcher running in that terminal. When provenlens itself is upgraded and its schema
changes, the next command rebuilds the index automatically and says `reset (older schema)`.

---

## Step 9 -- Wire it into Claude Code (optional, but the point)

First see what would be written, without writing it:

```bash
provenlens install claude-user --hooks --dry-run
```

**You should see** two things it would change: the MCP server entry in `~/.claude.json`, and two
hooks in `~/.claude/settings.json`. Then do it:

```bash
provenlens install claude-user --hooks
```

It leaves a `.bak` beside each file it edits. Restart Claude Code (or start a new session).

**What you now have.** Five MCP tools -- `provenlens_explore`, `provenlens_impact`,
`provenlens_affected`, `provenlens_why`, `provenlens_status` -- that Claude can call in any
repository that has a `.provenlens/` index. And two hooks: at the start of a session in an indexed
repository, one paragraph tells Claude the index is there; after every `Edit` or `Write`, Claude
sees what the file reaches and which tests cover it, without asking.

**Check it works:** open Claude Code inside a repository you indexed in Step 5 and ask
*"who calls X?"* for a method you know. The answer should cite `provenlens_explore`, not grep. Edit
any indexed file and you should see a line beginning `provenlens · path/to/file:` in the reply.

**One more thing to write yourself.** Agents use a tool when told to. Add the paragraph under
*Using it from Claude Code* in the README to your `CLAUDE.md` (global, or per repository) -- it
tells Claude to reach for the graph before grep, to check `provenlens_status` once, to say when it
fell back, and to treat the *Unlinked call sites* section as places to read rather than callers.

`provenlens install cursor` does the MCP half for Cursor. `provenlens install claude-project`
writes a `.mcp.json` into the current directory instead of your home; it is never automatic, so a
config file cannot land in a team repository by accident.

---

## Step 10 -- Optional: the web UI

```bash
provenlens serve -o
```

**You should see** a local address on port 7777 with a `?token=...` once, and a browser opening on
it. It serves only `127.0.0.1`. Pass several repository paths, or one folder holding several, to
browse them together. `-p 7800` if the port is taken.

---

## Updating provenlens

```bash
cd ~/provenlens && git pull && yarn install --frozen-lockfile
```

`--frozen-lockfile` refuses to move the pinned versions; if it fails, the lockfile and
`package.json` disagree and the safe thing is to read why before forcing it. Indexes built with an
older schema rebuild themselves on the next command.

---

## Uninstalling

Take back what Step 9 wrote (prints the change first; `--dry-run` to only print it):

```bash
provenlens uninstall
```

Remove a repository's index:

```bash
provenlens uninit /path/to/repo
```

Then delete `~/provenlens` and the symlink. Nothing else was written anywhere.

---

## When something is wrong

| You see | It means | Do this |
|---|---|---|
| `command not found: provenlens` | The symlink is missing or `~/.local/bin` is not on PATH | Step 3; `ls -l ~/.local/bin/provenlens` and `echo $PATH` say which |
| `Cannot find module 'node:sqlite'` | Node is older than 22 | Step 1 |
| `no .provenlens/ found here, in any parent, or one level down` | This repository was never indexed | `cd` into it, `provenlens init .` |
| `another provenlens is indexing this repository` | A `sync -w` or a Claude session holds the index lock | Wait for it, or stop the watcher |
| A `Language.load` or ABI error | `web-tree-sitter` moved off 0.25.10 | `cd ~/provenlens && yarn install --frozen-lockfile` |
| `resolution:` far below what the README shows for the language | Dependencies not installed, or the repository is mostly untyped Ruby/JS | `provenlens doctor` says which |
| `EADDRINUSE` from `serve` | Port 7777 is taken | `provenlens serve -p 7800` |
| Claude never uses the tools | MCP not registered, or the session started before install | `provenlens install claude-user --dry-run`; restart Claude Code; add the `CLAUDE.md` paragraph |

If none of these fits, `provenlens doctor` and `provenlens status` are the two outputs worth
pasting into an issue.
