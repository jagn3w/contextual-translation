# Diary

A second page beside Phrases: the learner writes a daily diary entry in the language they are
learning, and Claude, acting as a tutor, gives feedback like a teacher marking
homework. This file is the design and the contract between the backend and the frontend.

## Product rules

- The app has two menu options in the header: **Phrases** (the translator, `/`, the default) and
  **Diary** (`/diary`, and `/diary/<id>` for one entry). Client-side routing via `history.pushState`;
  Rails already serves the SPA for every HTML path.
- Diaries are private to the **access code** that created them. Every read and write is scoped to
  `current_session.access_code`; another code's entry id behaves exactly like a missing one.
- Every id the API exposes or accepts (entries, threads, comments; the `/diary/<id>` URL) is a
  random UUID, the record's `public_id`. Internal ids never leave the database, so nothing reveals
  how many entries exist; a malformed id behaves like a missing one.
- An entry has a **language** (what it is written in) and a **notes language** (the learner's own
  language: feedback, tips, hints and replies are written in it). A new entry defaults to the pair of
  the most recent entry, else English notes / Japanese writing (the Phrases showcase pair).
- A learner may write as many entries a day as they like: nothing is keyed or unique by date, and
  **New entry** always creates a fresh one.
- The left column is a scrollback of entries, newest created first: date and time (so two entries
  from the same day are told apart), language, and a preview of the first ~12 words. Entries from
  the same day sit under one date heading.
- The UI names Claude as the source of the feedback, as the Phrases page does ("Asking Claude…",
  "Claude is busy"); the diary reuses the same wording and error messages.

## Teaching the idiom, not the literal

Everything the tutor writes — tips, replies, hints — aims at how a native speaker would say what
the learner *means*, not at a word-for-word rendering of the learner's own language. Where the
learner's words could mean things the target language expresses differently (English "I want a
hamburger": Japanese 食べたい, want to eat one, versus 欲しい, want to get or have one), the tutor
does not pick one silently: if the meaning is clear it steers to the natural expression and names
the nuance; if not, it asks which they mean first. A "Help me say…" thread may therefore open with
that question instead of the first hint; asking for another hint without answering makes the tutor
go with the likeliest meaning and say so. A grammatical but literal sentence is `IMPROVABLE`.

## Feedback

- **Get feedback** saves the body and asks the tutor to review it. The tutor splits the entry into
  sentences and gives each a verdict: `WRONG` (red), `IMPROVABLE` (yellow), `CORRECT` (green /
  native-like), plus a tip written in the notes language. Tips teach — they point at the problem
  (which word, which rule) and do not hand over the corrected sentence unless it is already correct
  or the learner asks outright.
- Each sentence verdict is a **thread**: the tip is the tutor's first comment. Clicking a highlighted
  sentence opens a card with the thread; the learner can ask follow-up questions (the tutor replies
  in the thread) and **resolve** it. Resolved sentences lose their highlight colour.
- The tutor may also open **entry-wide threads** (kind `ENTRY`, with a short title) for things that
  span the entry: a recurring mistake, a point of grammar worth knowing, praise for a pattern.
- The learner edits and asks for feedback again. The tutor sees, each with its comments:
  - every **unresolved** thread, from any round, and
  - every thread from the **most recent round**, resolved ones included, marked as resolved, so it
    has the full context of the feedback it last gave.

  Resolved threads from older rounds are left out, and so are superseded (`current: false`)
  sentence threads the learner never commented on: the latest round's feedback replaced them. At
  most 60 threads are sent, the most recent; the backend logs (as counts only) when it drops any.
  With this context the tutor can say "fixed", notice a repeated mistake, and avoid repeating an
  entry-wide note that is still open.
- Sentence threads from earlier reviews become `current: false` (kept, shown under "Earlier
  feedback"); they are not resolved, because the learner did not resolve them.
- Highlight spans are offsets into `reviewedBody` (the body as it was reviewed), in Unicode code
  points, located by the backend (verbatim substring, cursor-ordered, non-overlapping — the
  GlossLocator rule). A sentence the backend cannot locate is dropped from highlighting but its thread
  still exists (no span). If the body has changed since the review, the feedback view shows
  `reviewedBody` and says it was edited since.

## Writer's block and hints

- **Ideas**: the tutor suggests three short prompts, each in the entry's language with a gloss in
  the notes language. With text already in the entry (the draft on screen, saved or not), they are
  follow-ups to it — the questions a friend reading it would ask next ("今日はハンバーガーが食べたかった"
  → "How did it taste?", "Who did you go with?"). With an empty entry they are fresh topics that
  avoid the learner's recent entries. Ephemeral — not stored.
- **Help me say…** (kind `HELP` threads): the learner writes, in their own language, what they want to
  say ("How do I say I went hiking with my sister?"). The tutor answers with a first hint in the
  style of the broad hint a teacher gives: it points at the one thing that unlocks the sentence
  (the tense to reach for, the structure that fits, the kind of word missing) so that it genuinely
  moves the learner forward, without writing the sentence for them. **Another hint** gives the next
  one, each more revealing: 1 that broad teacher's hint, 2 key vocabulary, 3 a partial sentence with
  gaps, 4+ the full sentence with an explanation. `hintLevel` counts general hints given. A
  question about what the learner means (see above) is not a hint: a thread that opens with one
  has `hintLevel` 0, and **Another hint** after one asks for the same level again. The
  learner can also reply with a specific question, which the tutor answers directly.

## Backend

- Tables: `diary_entries` (access_code_id, language, notes_language, body, reviewed_body,
  reviewed_at), `diary_threads` (diary_entry_id, kind, verdict, sentence, starts_at, length, title,
  current, hint_level, resolved_at, review_round), `diary_comments` (diary_thread_id, author,
  body). Foreign keys with cascade delete. `review_round` is the entry's review count when a
  SENTENCE or ENTRY thread was created (null for HELP), so "the most recent round" is a query, not
  a guess.
- Each diary table has `public_id uuid NOT NULL DEFAULT gen_random_uuid()` (unique index): the
  only id in GraphQL input and output (`PublicId.parse` rejects anything not UUID-shaped before it
  reaches Postgres). The bigint primary keys come from app-wide sequences, so they stay internal:
  foreign keys and `order(:id)` only.
- `Diary::Tutor` interface with `FakeTutor` (deterministic; TRANSLATOR=fake, tests, CI) and
  `ClaudeTutor` (structured outputs, one prompt per operation). Both share the one Anthropic client and
  the call/retry/deadline/credential machinery with `ClaudeTranslator`, so there is one WIF token
  refresher per process.
  Each prompt, its tags, schema and reply handling: [prompts.md](prompts.md).
- Diary text is the learner's words: it goes inside tags, is treated as text never as instructions,
  and is never logged.
- Every tutor call counts against `Translation::RateLimiter` (the same per-session and per-code
  limits as a translation) and fails with the same typed errors (`TranslateError`).
- Limits: body 10,000 characters, a comment or question 2,000. Feedback works on up to **2,000
  characters** at a time (`Diary::Service::MAX_REVIEW_LENGTH`, an unmeasured estimate: the review
  echoes every sentence with a tip, and has to arrive inside the 30 s SDK timeout). A longer body
  can be saved as a draft, but `reviewDiaryEntry` returns `INPUT_TOO_LONG` in the payload and saves
  nothing. Output budgets: `ClaudeTutor::REVIEW_MAX_TOKENS` 32,000 (worst case ≈ 9,800 at the
  review limit), `SHORT_MAX_TOKENS` 4,000 for replies, hints and topics (worst ≈ 2,300); the
  arithmetic is beside the constants.

## GraphQL contract

```graphql
enum DiaryVerdict { CORRECT IMPROVABLE WRONG }
enum DiaryThreadKind { SENTENCE ENTRY HELP }
enum DiaryAuthor { LEARNER TUTOR }

type DiaryEntry {
  id: ID!                           # public_id, a random UUID (every diary id is one)
  language: Language!
  notesLanguage: Language!
  body: String!
  preview: String!                  # first ~12 words of body, "" when empty
  reviewedBody: String              # null until the first review
  reviewedAt: ISO8601DateTime
  createdAt: ISO8601DateTime!
  updatedAt: ISO8601DateTime!
  threads: [DiaryThread!]!          # creation order
}

type DiaryThread {
  id: ID!
  kind: DiaryThreadKind!
  verdict: DiaryVerdict             # SENTENCE only
  sentence: String                  # SENTENCE: the sentence as reviewed; HELP: the question
  startsAt: Int                     # SENTENCE: code-point span in reviewedBody; null if unlocated
  length: Int
  title: String                     # ENTRY only
  current: Boolean!                 # false for SENTENCE threads superseded by a later review
  hintLevel: Int!                   # HELP: general hints given so far
  resolved: Boolean!
  createdAt: ISO8601DateTime!
  comments: [DiaryComment!]!        # oldest first
}

type DiaryComment { id: ID! author: DiaryAuthor! body: String! createdAt: ISO8601DateTime! }
type DiaryTopic { prompt: String! gloss: String! }

type Query {
  diaryEntries: [DiaryEntry!]!      # this access code's, newest createdAt first
  diaryEntry(id: ID!): DiaryEntry   # null when missing or not this code's
}

type Mutation {
  createDiaryEntry(input: CreateDiaryEntryInput!): DiaryEntryPayload!   # {language, notesLanguage}
  updateDiaryEntry(input: UpdateDiaryEntryInput!): DiaryEntryPayload!   # {id, body?, language?, notesLanguage?}; no tutor call
  deleteDiaryEntry(input: DeleteDiaryEntryInput!): DeleteDiaryEntryPayload!  # {id} -> {deletedId}
  reviewDiaryEntry(input: ReviewDiaryEntryInput!): DiaryEntryPayload!   # {id, body}: save + review
  startDiaryHelpThread(input: StartDiaryHelpThreadInput!): DiaryThreadPayload!  # {entryId, question}
  replyToDiaryThread(input: ReplyToDiaryThreadInput!): DiaryThreadPayload!      # {threadId, body}
  requestDiaryHint(input: RequestDiaryHintInput!): DiaryThreadPayload!          # {threadId}
  resolveDiaryThread(input: ResolveDiaryThreadInput!): DiaryThreadPayload!      # {threadId, resolved}
  suggestDiaryTopics(input: SuggestDiaryTopicsInput!): DiaryTopicsPayload!      # {language, notesLanguage, body?}
}

type DiaryEntryPayload { entry: DiaryEntry errors: [TranslateError!]! }
type DiaryThreadPayload { thread: DiaryThread errors: [TranslateError!]! }
type DiaryTopicsPayload { topics: [DiaryTopic!]! errors: [TranslateError!]! }
type DeleteDiaryEntryPayload { deletedId: ID }
```

An entry's language pair can change only until its first feedback or help thread (once it has
been reviewed or has any thread, `updateDiaryEntry` with a different language raises a top-level
error, code `INVALID`); a pair of one language twice is a
`SAME_LANGUAGE` error in the payload. An entry can be deleted from its header, after a
confirmation. Bare `/diary` shows a prompt to choose or start an entry.

`diaryEntry(id)` returns null for a missing or foreign id. A mutation given one raises a top-level
GraphQL error with `extensions.code = "NOT_FOUND"`, and so does a tutor mutation whose entry or thread was deleted while the tutor was answering.
Mutations that call the tutor carry complexity 100, like `translate`, so one request makes at most
one tutor call.
