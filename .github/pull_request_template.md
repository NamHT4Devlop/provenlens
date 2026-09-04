<!--
  The checks on this PR ask for two things a diff cannot show on its own: the
  test that fails without your change, and the measurement behind any claim
  about the numbers. Answering them here saves a round trip.
-->

## What this changes, and why

<!-- The why matters more than the what; the diff already says the what. -->

## The test that fails without it

<!--
  Which test, and did you watch it fail before the fix? A test that passes
  either way documents nothing.

  If this cannot alter how calls resolve — a refactor, a docs change — say so
  and label the PR `no-behaviour-change`.
-->

## What it does to the numbers

<!--
  If this touches resolution, run `node scripts/bench.js <a real repo>` before
  and after and paste both figures, headline and floor:

      repo        before -> after   (floor before -> after)

  A lower number can be the right answer. Refusing to resolve where the source
  does not say is correct even when it costs coverage — say that plainly rather
  than working around it.
-->

## Anything this repository refuses to become

<!--
  Tick only if the PR touches one, and say why it is worth it:
  - [ ] adds a runtime dependency (there are four)
  - [ ] adds a dev dependency (there are none)
  - [ ] adds a build or install step (there is none)
  - [ ] reaches the network at runtime (nothing does)
  - [ ] writes outside `.provenlens/` in the user's repository
-->
