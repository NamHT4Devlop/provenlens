#!/usr/bin/env bash
# The protection main should have, written down so it is reviewable and so
# applying it is one command rather than eleven checkboxes remembered wrongly.
#
#   ./scripts/protect-main.sh                     # main becomes pull-request only
#   ./scripts/protect-main.sh --allow-direct-push # keep pushing to main directly
#   ./scripts/protect-main.sh --show              # print what is in force now
#
# GitHub refuses rulesets on a private repository outside a paid plan, so this
# cannot run until the repository is public (or the account is on Pro/Team).
# It says so rather than failing with a bare 403.
set -euo pipefail

REPO=${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}

# Every check the four verification workflows produce. A rule listing a check
# that no workflow emits blocks every pull request forever, so this list is
# kept next to the workflows that create it.
CHECKS=(
  "Test suite · Node 22 · Linux"
  "Test suite · Node 24 · Linux"
  "Test suite · Node 24 · macOS"
  "codelens still indexes itself above 90%"
  "Nothing in the source can reach the network"
  "Known vulnerabilities in the lockfile"
  "No index, session or vendor directory is committed"
  ".gitignore still covers what this tool writes"
  "LICENSE and README are present"
  "A change to the resolver comes with a test"
  "The README's test count matches the suite"
)

MODE=pr-only
case "${1:-}" in
  --show)
    gh api "repos/$REPO/rulesets" --jq '.[] | {name, target, enforcement}' 2>/dev/null \
      || echo "no rulesets readable (private repository on a free plan, or none set)"
    exit 0 ;;
  --allow-direct-push) MODE=guard-only ;;
  "") ;;
  *) echo "usage: $0 [--show | --allow-direct-push]"; exit 64 ;;
esac

# CodeQL and dependency review are listed because this script is meant to run
# once the repository is public, which is exactly when those two stop skipping.
#
# "Claude reviews this pull request" is deliberately absent. It does not run on
# a pull request from a fork -- a fork gets no secrets -- and a required check
# that never reports leaves every such PR waiting forever.
CHECKS=(
  "Test suite · Node 22 · Linux"
  "Test suite · Node 24 · Linux"
  "Test suite · Node 24 · macOS"
  "codelens still indexes itself above 90%"
  "Nothing in the source can reach the network"
  "Known vulnerabilities in the lockfile"
  "CodeQL · JavaScript"
  "Dependencies this PR adds"
  "No index, session or vendor directory is committed"
  ".gitignore still covers what this tool writes"
  "LICENSE and README are present"
  "A change to the resolver comes with a test"
  "The README's test count matches the suite"
)

payload=$(printf '%s\n' "${CHECKS[@]}" | MODE="$MODE" node -e '
  let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    const contexts = raw.split("\n").filter(Boolean).map((context) => ({ context }));

    // These two are the ones nobody argues with: main cannot be deleted and its
    // history cannot be rewritten. They cost the maintainer nothing.
    const rules = [{ type: "deletion" }, { type: "non_fast_forward" }];

    if (process.env.MODE === "pr-only") {
      rules.push({
        type: "pull_request",
        parameters: {
          // A sole maintainer cannot approve their own pull request, so
          // requiring one review would lock them out of their own repository.
          // The checks are what must pass; the approval is not the point.
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
        },
      });
      rules.push({
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: contexts,
        },
      });
    }

    // No bypass_actors. The actor id for a repository role is a number this
    // script cannot verify on a plan that refuses to read rulesets, and a
    // guessed id either fails loudly or grants a bypass to the wrong role.
    // The owner can lift the ruleset in Settings, which is honest about what
    // is happening in a way a silent bypass is not.
    console.log(JSON.stringify({
      name: "main",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules,
    }));
  });
')

if ! out=$(printf '%s' "$payload" | gh api -X POST "repos/$REPO/rulesets" --input - 2>&1); then
  if printf '%s' "$out" | grep -q "Upgrade to GitHub Pro"; then
    echo "GitHub will not take a ruleset on a private repository on this plan."
    echo "Make $REPO public, or move to Pro/Team, then run this again."
    exit 2
  fi
  echo "$out" >&2
  exit 1
fi
printf '%s' "$out" | node -e '
  let raw = ""; process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    const r = JSON.parse(raw);
    console.log(`ruleset "${r.name}" is ${r.enforcement}, ${r.rules.length} rule(s)`);
    for (const rule of r.rules) console.log("  " + rule.type);
  });
'
