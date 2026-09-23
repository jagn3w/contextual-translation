# Code review — task/diary @ 2026-09-21 11:09

Base: main...HEAD · HEAD: 33e111e · Effort: low (unverified) · Reviewers: 3 · Findings: 10 for this change (of 10 raw, 0 refuted) · Pre-existing filed to the backlog: 0

## Must-fix

- [ ] The Apollo cache and drafts map are cleared only on a deliberate sign-out. When a session ends any other way, the next access code on that tab sees the previous code's diary entries, bodies, reviews and drafts from cache. — frontend/app/src/App.tsx:35 !p1
  Learner A has /diary open. A's session expires, is revoked, or is signed out in another tab. onUnauthenticated only sets sessionEnded and bumps the epoch. Learner B then signs in on the same tab. DiaryEntries is cache-first, so it renders A's scrollback without a network request. Opening an entry shows A's full body and threads, and unsavedDraft() restores A's unsaved draft into the editor. This bypasses the backend's per-access-code scoping. Unverified, but the mechanism is stated concretely and is internally consistent.
  Fix: Call client.clearStore() and forgetDrafts() in the onUnauthenticated path, or before the gate's onSignedIn restart. Add a test that signs in with a second code after the session ends.

## Concern

- [ ] flushAutosaves resolves the same way whether the save succeeded or failed. Sign-out then runs forgetDrafts() and clearStore() and silently throws away a draft whose final save was refused. — frontend/app/src/lib/useAutosave.ts:28 !p2
  The learner's final save fails with INPUT_TOO_LONG (entry over 10,000 code points), a transient 5xx, a 429 from rack-attack, or the 5 s timeout. The learner clicks Sign out. The flush resolves void, and handleSignOut deletes the session, forgets the drafts and clears the store. The unsaved text is lost with no warning. This contradicts App.tsx's own comment that drafts are flushed first so they are not 'refused and lost'. It needs a failed save to coincide with sign-out, so it is a concern rather than a merge blocker.
  Fix: Have flush and flushAutosaves report whether every draft reached the server. If any did not, stop the sign-out or ask the learner to confirm, and keep the drafts map.

- [ ] The review round and the hint level are read before the tutor call and written after the re-lock without being re-read. Two overlapping requests persist the same round or level, and a slow hint can lower the level. — backend/app/services/diary/service.rb:91 !p2
  An entry has review_count 2. The learner clicks Get feedback in two tabs, or retries after a network drop. Both requests compute round 3 and persist review_count 3. The DB ends up with two sets of round-3 threads: the next review's context carries both, and review_count undercounts. request_hint has the same shape (reads at line 176, writes at line 188), so two 'Another hint' clicks both store level 2.
  Fix: Inside the locked transaction, compute the round from the reloaded entry.review_count + 1 and the level from the reloaded thread.hint_level + 1. Alternatively, refuse the write when the locked row no longer matches what was sent to the tutor.

- [ ] Each reply, hint and review sends every thread's full comment history to Claude with no cap. Old threads eventually exceed the context window or the 30 s timeout and fail on every retry. — backend/app/services/diary/service.rb:265 !p2
  A long discussion on one sentence thread adds up to 2,000 characters plus a tutor answer per turn, and context_thread and request_hint resend all of it every time. review_context caps the number of threads at 60 but not their size. Cost and latency grow until the call fails upstream, and editing the entry cannot fix it. docs/prompts.md gives no budget for this input, although it gives one for every other prompt input.
  Fix: Send only part of each thread's comments, for example the first tutor comment plus the last N, and optionally cap the total characters of the review context. Log dropped counts, and document the budget next to the constant and in prompts.md.

- [ ] The language-pair check does not take the row lock, and persisting the tutor's answer never re-checks the pair. Feedback written for one language pair can be saved on, and then lock, an entry that now uses another pair. — backend/app/services/diary/service.rb:136 !p2
  On an empty new entry (ja writing, en notes), the learner asks 'Help me say…'. While Claude is answering, the learner switches the writing language to es. The picker is still offered because the body and threads are empty, and update_entry's check at line 68 passes. start_help_thread then saves a Japanese hint on an es entry, which locks the pair to es with a Japanese thread. This needs the learner to switch languages mid-request, so it is narrower than the round race.
  Fix: In lock_or_not_found!'s transaction for start_help_thread and persist_review, compare the locked entry's language and notes_language with the ones sent to the tutor, and refuse the write if they differ.

## Nit

- [ ] RequestSizeLimit runs as a before_action, after Rails has already read and parsed the body. The new 411 branch's stated purpose, not buffering the body, is false. Only Puma's limit actually prevents the buffering. — backend/app/controllers/concerns/request_size_limit.rb:33 !p3
  The finder ran a chunked 70 KB POST /graphql through bin/rails runner. It returned 411, but RAW_POST_DATA already held 70,069 bytes, because instrumentation and ParamsWrapper read the parameters before callbacks run. Production is protected by Puma's http_content_length_limit. Off Puma, and in tests, a multi-MB body is read in full, contrary to the comments and docs/backend.md. Demoted from concern: production is unaffected, so the harm today is a false guarantee in the comments and docs.
  Fix: Move the check into a Rack middleware inserted at position 0. Otherwise, rewrite the comments and docs/backend.md to say Puma's limit is the real guard.

- [ ] diaryErrorMessage replaces the backend's specific INPUT_TOO_LONG message with a catch-all listing all three limits. The comment justifying this, that the error does not say which limit applied, is false. — frontend/app/src/pages/DiaryPage.tsx:71 !p3
  Diary::Service sends a separate message for each limit: review, save and comment. When the client and server counts disagree, for example over line endings, the learner sees a toast listing all three limits instead of the one that applied.
  Fix: Use error.message for INPUT_TOO_LONG, as the default branch already does, or at least correct the comment.

- [ ] The 64 KB body cap is duplicated as a literal in puma.rb and as RequestSizeLimit::MAX_BODY_BYTES, and nothing keeps the two in step. — backend/config/puma.rb:40 !p3
  If MAX_BODY_BYTES is raised but puma.rb is not, tests pass (they do not run Puma), while production still returns Puma's plain 413 for bodies between 64 KB and the new limit. The cost is hypothetical today.
  Fix: Define the value once so both places read it, or add a test asserting that puma.rb's limit equals MAX_BODY_BYTES.

- [ ] MessageCaller claims to own everything around the call so the callers cannot drift, but it leaves the timeout, the fallback beta and `fallbacks: :default` for each caller's block to repeat. — backend/app/services/claude/message_caller.rb:57 !p3
  ClaudeTranslator and ClaudeTutor both copy these options correctly today. A future block that omits the timeout would fall back to the 600 s default, past the 55 s deadline. No current caller gets it wrong, so this stays a nit.
  Fix: Have MessageCaller take the request params and make the beta.messages.create call itself, adding the timeout, betas and fallbacks in one place.

- [ ] The new claude.rb (and the moved MessageCaller comments) cite design D-numbers. CLAUDE.md, added on this branch, forbids that because design/ is not in the repo. — backend/app/services/claude.rb:7 !p3
  A reader who follows 'design D5.2' finds no such document in the repository.
  Fix: Drop the D-numbers and keep the docs/diary.md and docs/backend.md pointers.
