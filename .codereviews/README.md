# Code reviews

Every change in this repo was reviewed before it landed. Each directory here is one review run,
named `<date>-<time>-<branch>-<N>`, and holds what that run produced:

| File | What |
|---|---|
| `tasks.md` | The findings as a checklist, grouped by severity (Must fix / Concern / Nit) and ranked. This is the readable one. |
| `review.json`, `be.json`, `fe.json` | The raw structured output the reviewers returned. A run split by path (backend / frontend) writes one file per half. |

Each finding carries a concrete failure scenario — the inputs and state that produce the wrong
behaviour — and a proposed fix, so it can be argued with rather than taken on faith. Findings the
verification pass could not confirm are marked `Unverified` and say what was not checked.

The header line of each `tasks.md` records the base commit, the number of reviewers, and how many
raw findings were consolidated or refuted before the list was written.

Commit messages reference these runs directly ("Fix all 15 findings from the first code review").

The reviewer that produced them — how a change is split among reviewers, how findings are
deduplicated, and how each one is verified before it is reported — is not part of this repo. It
lives in [jkb](https://github.com/jagn3w/jkb), the task and review harness these runs were driven
from.
