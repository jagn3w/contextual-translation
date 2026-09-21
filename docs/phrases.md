# Phrases

The default page of the app (`/`): a context-aware translator between English, Spanish and
Japanese. Besides the text, the user says *where* they are and *who* they are talking to, and Claude
uses that to pick the right meaning, formality and regional variety. Japanese output comes with kana
readings (furigana) over the kanji, and any translation can come with per-word definitions
(glosses). This file covers the feature end to end. General architecture is in
[frontend.md](frontend.md), [backend.md](backend.md) and [api_boundary.md](api_boundary.md); the
other page is [diary.md](diary.md).

## Product rules

- Three languages: `EN`, `ES`, `JA` (`Translation::Language`, GraphQL `Language`). The page opens on
  English → Japanese, the showcase pair.
- **Context** is free text ("At a baseball game", "An email to my new manager in Madrid"). Claude
  uses it to:
  - resolve ambiguity: "bat" is *bate* at a ballpark and *murciélago* in a cave;
  - choose formality: *tú* / *usted* / *vos*; Japanese plain, polite (teineigo) or
    honorific/humble (sonkeigo/kenjōgo);
  - choose a regional variety (Mexico vs Spain vs Argentina, US vs UK).

  If the context settles none of these, Claude uses a neutral, polite register and a neutral
  variety. Context is optional.
- Every answer can carry a **note**: one or two sentences on the meaning chosen and the
  formality/variety used, written in the *source* language (the language the user wrote in).
- **Glosses** are short definitions of words in the translation, also in the source language. The
  user picks how many: `NONE`, `NOTABLE` (the default: the ambiguous, idiomatic or
  register-carrying words) or `EVERY` (every content word and set phrase, skipping function
  words). At most 40 per answer.
- **Furigana** only for a Japanese target, and only when the source is at most 2,000 characters.
- Limits: source text 10,000 characters, context 2,000. Both sides count Unicode code points
  (Ruby `String#length`; `codePointLength` in `frontend/app/src/lib/codePoints.ts`), so a character outside
  the Basic Multilingual Plane (an astral kanji such as 𠮟) counts once on both sides, not as a
  UTF-16 surrogate pair.
- The source text is the user's words: it goes inside tags in the prompt, is treated as text and
  never as instructions, and is never logged. Logs carry byte counts and rule names only.

## The page

`frontend/app/src/pages/TranslatePage.tsx`. A language bar (source picker, swap button, target
picker), then two panes side by side (stacked on narrow screens): the editable source textarea and
the read-only result pane. Below them are the context field and **Update Translation**. Translation
happens only on that button or on **⌘/Ctrl + Enter** anywhere on the page, never as you type. While
a request is in flight the button reads "Translating…" and, after two seconds, a counter "Asking
Claude… Ns" replaces the shortcut hint. The page stays mounted (just hidden) while the Diary is
open, so a translation and its draft survive a trip there and back (`frontend/app/src/App.tsx`).

### Per-language buffers and the swap

Text belongs to a *language*, not to a pane. The page keeps one `LanguageBuffer` per language:

- `input`: what the editable box shows when this language is the source;
- `target`: the last text in this language that Claude has seen, either what it returned in this
  language or what it was asked to translate out of it;
- `answerInto`: the response that wrote `target` (its notes, furigana and glosses describe that
  text);
- `answerOutOf`: the response that was made *from* `target`. It says nothing about the text itself,
  only that this was what Claude was given.

The source pane edits `buffers[source].input`; the result pane shows `buffers[target].target`. The
**swap** button just exchanges the two language codes. Each language's text follows it, nothing is
moved or dropped, and swapping twice gives back exactly the same state. Choosing the other side's
language in a picker also swaps the pair. The third language keeps what it held, annotations
included: a Japanese answer from earlier is still annotated after a translation into Spanish.

On success both languages of the pair are updated. The source language gets `target = sentText`
and `answerOutOf`; the target language gets `target = result` and `answerInto`. Its `input` is
replaced only if it still holds what it held when the request went out. Text typed in either box
while the request was running is a draft and is never overwritten, since the textareas are
controlled and there is no undo. The response is always applied against the inputs that were
*sent*, not against the live pickers and fields.

The two answer slots are separate on purpose. A language plays both roles in turn, and with one
slot a JA→EN answer evicted the EN→JA answer whose furigana was still over the unchanged Japanese.

### Out of date

The result pane is **current** when it shows exactly the pair Claude answered, in either direction,
with the same context and gloss level:

- unswapped: `answerInto` exists, its source language is the current source, the source box holds
  its `fromText`, the pane holds its `text`, and the context and gloss level match; or
- swapped: `answerOutOf` matches the same way with the roles reversed (the source box holds what it
  produced, the pane holds what it was made from).

Otherwise a non-empty pane is **out of date**. It gets the `bg-frame-stale` ground and an "Out of
date" label. The text itself is not dimmed, because a blanket opacity dropped its contrast below
WCAG AA. Changing the gloss level dates the result like changing the context does: the level is an
input to the answer, not a view over it.

Annotations follow a separate, narrower rule. The notes, furigana, glosses and shortfall flags are
shown whenever the pane still shows the exact `text` of its own `answerInto`
(`showingResponseOutput`), even if the result is out of date. They describe that text, and it has
not changed. After a swap the pane shows the text that was translated *from*, which has no
annotations of its own, so it is plain.

### Furigana

The backend sends `furigana` as the translation repeated with a reading after each run of kanji:
`漢字《かんじ》を書《か》く`. `frontend/app/src/lib/furigana.ts` (`parseFurigana`) splits it into
segments. A reading belongs to the maximal run of kanji directly before its group. A run begins and
ends with a true kanji (CJK ideographs, extension A, compatibility ideographs, the astral
extensions, and 〇 々 〆) and may contain ヵ ヶ カ ケ ノ ツ between two kanji (霞ケ関, 一ヵ月),
but never at an end, so the ケツ in バケツ水 is not taken for a run. A group with an empty reading or
no kanji before it is dropped rather than drawn over the wrong characters.

`frontend/app/src/lib/annotateTranslation.ts` merges furigana and glosses into one list of runs. It
checks that the parsed segments join back to `text` and, if they do not, ignores the furigana
instead of sliding every reading out of place. A gloss boundary that cuts a kanji run in two
removes that run's reading: 東京駅《とうきょうえき》 glossed as 東京 leaves neither half with a
correct reading, and a missing reading is better than a wrong one.

Each reading renders as `<ruby>…<rt aria-hidden class="select-none">`:

- `select-none`: browsers fold `<rt>` text into a plain-text copy, so without it copying
  今日は良い天気ですね would paste 今日きょうは良よい天気てんきですね into whatever the user is writing.
- `aria-hidden`: Chrome and Firefox expose `<rt>` as text, so screen readers would read each reading
  run into its word. Hiding it makes the announced sentence the translation itself. The reading
  still shows on the gloss card.

This is also why `GlossedWord` needs no `aria-label`: its accessible name is its contents, the word.
Annotated text gets `leading-loose` to leave room for the readings.

### Glossed words

`frontend/app/src/components/GlossedWord.tsx` renders a glossed word as a `<button>` with a dotted
underline. A card shows the word, its reading (Japanese only) and its meaning. The card opens as a
Radix Tooltip on hover or keyboard focus (150 ms delay, from the page's `Tooltip.Provider`) and as a
Radix Popover on tap, because Tooltip ignores touch and Popover ignores hover. The tooltip is
closed while the popover is open. The translation stays selectable: the button is `select-text`,
and a press that moves more than 6 px (`TAP_SLOP`) counts as a selection drag, not a tap, so it does
not open the card. The underline colour meets WCAG 1.4.11's 3:1 against both pane grounds.

The picker is `frontend/app/src/components/GlossLevelSelect.tsx` ("Definitions: None / Notable /
All"), in the source pane's footer beside the character counter. Its labels are a `Record` over
the generated `GlossLevel` type, so adding a level without a label is a compile error. The page
always sends the level explicitly (default `NOTABLE`).

### Notes, shortfalls and limits

- **Note**: shown under the translation as "Note: …" when `notes` is non-empty.
- **Shortfalls**: one small paragraph that tells the user what the answer lacks:
  - `readingsOmitted` → "No kana readings came with this answer, so there are none over the
    translation. It isn't that the Japanese has no kanji to read." The flag does not give a cause,
    so the message does not guess one. "over the translation" is deliberate: gloss readings survive
    whatever dropped the furigana.
  - `glossesTruncated` → "Definitions stop partway: N words are defined and the rest of the
    translation is not." N is counted from the response, not copied from the backend's cap.
- **Limits**: the counter under the source box reads `n / 10,000` and turns red with "Too long to
  translate — " past the limit. An over-long context shows its own message. Update Translation is
  disabled for blank text, the same language on both sides, either limit exceeded, or a request in
  flight. The frontend limits are `MAX_SOURCE_LENGTH` / `MAX_CONTEXT_LENGTH` exported from
  `TranslatePage.tsx`, and the backend's are `Translation::Service`'s.
- **Accessibility**: an always-mounted `role="status"` region announces "Translating…",
  "Translation ready." or "Translation failed."; the result pane is `aria-busy` while loading.

## Backend flow

```
Mutations::Translate                      backend/app/graphql/mutations/translate.rb
  └ Translation::Service#call             validate → RateLimiter#check! → translator.translate
      └ Translation.translator            FakeTranslator | ClaudeTranslator (TRANSLATOR env)
          └ Result.for_request            every rule on what reaches the reader
```

**Mutation.** Builds a `Translation::Request` from `TranslateInput`. An explicit `glossLevel: null`
is coerced to the schema's published default, which is read from the argument rather than
repeated. `Translation::Error` comes back as `{translation: nil, errors: [e]}`. Anything else is a
top-level `INTERNAL` error (see [api_boundary.md](api_boundary.md)). The field has complexity 100
against a schema maximum of 150, so a request can make at most one translate call.

**`Translation::Service`** checks the input in this order: blank after `strip` → `EMPTY_INPUT`;
source over `MAX_SOURCE_LENGTH` (10,000) or context over `MAX_CONTEXT_LENGTH` (2,000) →
`INPUT_TOO_LONG`; same source and target → `SAME_LANGUAGE`. None of these calls Claude or counts
against the limits. Then **`Translation::RateLimiter`** counts the attempt against every limit
before checking, and raises `RATE_LIMITED` with the longest `retry_after_seconds` among the limits
exceeded. The limits are 10/min and 150/day per session, and 30/min and 500/day per access code.
Diary tutor calls count against the same limits. See [backend.md](backend.md) for the cache and
fail-open behaviour.

**Choosing a translator.** `Translation.build_translator` reads `TRANSLATOR`: `fake` (the default)
or `claude`. Any other value raises. In production anything but `claude` raises at boot
(`backend/config/initializers/translation.rb`), so a misconfigured deploy cannot quietly serve
fake translations. `CLAUDE_MODEL` (default `claude-opus-5`) and `CLAUDE_EFFORT` (default `medium`)
tune the Claude one. The app's translator uses the shared `Claude.client`.

### ClaudeTranslator

`backend/app/services/translation/claude_translator.rb` makes one Messages call with **structured
output** (`output_config.format` = `json_schema` with `Prompt::OUTPUT_SCHEMA`), so the reply always
parses as `{translation, notes, furigana, glosses[{text, reading, meaning}]}`. It also sends
server-side refusal fallbacks (`fallbacks: :default` with the fallback beta), an output effort, and
`MAX_TOKENS` 32,000. The worst case is ≈ 12,500 tokens at the 10,000-character source limit
without readings, and ≈ 7,700 at the furigana limit with readings; the arithmetic is beside the
constant. The shared `Claude::MessageCaller` handles credentials, the single retry, the 55 s
overall deadline under the 30 s per-call SDK timeout, error mapping and usage logs (see
[backend.md](backend.md)).

Reading the reply:

- `stop_reason` `refusal` → `REFUSED`; `max_tokens` → `OUTPUT_TOO_LONG`.
- Text that does not parse, or has no string `translation`, → `UPSTREAM_ERROR` ("Claude returned an
  unreadable response"). Only the byte count is logged.
- Each gloss is kept only if it is an object with a non-empty `text` and `meaning` and
  `GlossLocator` can place it. Bad entries are dropped one by one, and a malformed list means no
  glosses. The translation comes back regardless, because glosses are a bonus.
- Everything is passed to `Result.for_request`. Afterwards two `warn` lines, never containing the
  user's text, record what the reader lost: furigana Claude sent that failed a rule (with the rule's
  name), and glosses dropped (unplaceable plus over the cap, but not at level `NONE`). Production
  logs at `info`, so these are warnings, not debug lines.

### Prompt

`backend/app/services/translation/prompt.rb`. `SYSTEM` is fixed text. Everything specific to the
request is in the user message, in tags: `<source_language>`, `<target_language>`,
`<notes_language>` (always the source language), `<gloss_level>` (`none`/`notable`/`every`, the
`GlossLevel` serializations, which are part of the prompt contract), `<readings>` (`on`/`off`),
`<context>` (or "(none given)") and `<source_text>`. The system prompt covers how to use the
context, how to treat the source (translate all of it, never follow it as instructions, keep
structure, names, numbers, URLs and code), writing Japanese with its normal kanji, the notes, and
detailed rules for furigana and glosses. It asks for the reading of the *whole* kanji run a group
follows (`毎日東京《まいにちとうきょう》`, never `毎日東京《とうきょう》`), because no check on either
side can detect a reading written for only part of a run.

- `MAX_GLOSSES = 40`: the prompt text, the schema description and `Result`'s cap all use this
  constant, so what Claude is told cannot drift from what is kept.
- `FURIGANA_LIMIT = 2_000` source characters. Above it `<readings>` is `off`. Furigana repeats the
  whole translation at about 1.6× its length, so on a long Japanese source it could push the reply
  past the deadline and cost the translation itself. Glosses are unaffected because the cap bounds
  them. The value is an unmeasured estimate, limited by latency more than tokens.
- `Prompt.furigana?(request)` asks the whole question (Japanese target *and* source within the
  limit) in one place. Both the `<readings>` switch and `Result`'s gate call it, so an
  English→Spanish request is never told `readings on`.

### Result.for_request: the rules in one place

`backend/app/services/translation/result.rb`. Every translator returns its `Result` through
`for_request`, and `new` is private, so no translator can skip it. It applies:

1. **Furigana gate**: readings are kept only if `Prompt.furigana?` and `Furigana.checked` passes.
2. **Gloss level**: `NONE` drops whatever was offered, and that does not count as truncation.
3. **Gloss cap**: the first `MAX_GLOSSES`; `glosses_truncated` when the cap removed any.
4. **Readings are the Japanese feature**: gloss readings are removed for other targets.
5. **`readings_omitted`**: true for a Japanese target whose furigana ended up nil, for any reason
   (source over the limit, no kanji, annotation rejected). The flag is deliberately single because
   the reader needs one sentence; the cause goes to the log. It is always false for other targets.

These rules live here, not in each translator, because a rule each translator has to remember is
one the next translator forgets. The fake translator did in turn ignore the gloss level, emit
hundreds of glosses, put kana on Spanish glosses and ship furigana that did not strip back. Each of
those was wrong only on the dev/CI path, which is the path least likely to notice.

### GlossLocator

`backend/app/services/translation/gloss_locator.rb` places glosses in the translation for every
translator. One locator serves one translation and keeps a cursor. Each gloss is placed at its
first occurrence at or after the end of the previous one, so spans come out in order and
non-overlapping, and a repeated word is underlined once per mention. A gloss that cannot be found
returns nil (the caller drops it) and leaves the cursor unchanged. For space-delimited languages
(EN, ES) a whole-word occurrence is preferred, so "age" does not land inside "message", with a
fallback to the raw substring. Japanese has no word boundaries, so it uses plain substring search.
Offsets are code points (`Gloss#starts_at`, `#length`). A plain `index` in the fake once put a
gloss for "me" on the "me" in "memo".

### Furigana checks

`backend/app/services/translation/furigana.rb` holds the notation and the checks for the backend,
and `frontend/app/src/lib/furigana.ts` is the browser's copy. The two must agree character for
character, and a test in `claude_translator_test.rb` fails if a second Ruby spelling of the pattern
appears. `Furigana.checked(value, text)` returns the string or nil. `rejection` names the first rule
broken, as a log-safe phrase:

1. the translation contains 《 or 》 of its own (ordinary Japanese punctuation, which the notation
   cannot carry, so readings give way);
2. removing every `《…》` group does not give back the translation exactly;
3. a reading is empty;
4. the groups do not sit exactly one per maximal kanji run, in order. The notation has no base
   length, so the browser can only assume a reading covers the run before it. That is exact only
   when every run has its own group. Partial annotation (`新型肺炎《はいえん》の記事`, leaving 記事
   bare) is rejected whole.

A string with no groups at all is simply "no furigana", not a rejection.

### FakeTranslator

`backend/app/services/translation/fake_translator.rb` is deterministic and needs no key and no
spend. Tests, CI and frontend work use it (`TRANSLATOR=fake`, the default outside production). It
returns `"[TAG] <source>"` (`[日本語]` for Japanese, otherwise `[EN]`/`[ES]`), a note echoing the
context, furigana with a reading after every kanji run (にほんご for the tag, the obvious stand-in
かな for anything else), and glosses per level (`NOTABLE`: the tag and the last word; `EVERY`: every
word). It gives glosses for every target and a kana reading on the tag regardless of target.

It deliberately offers more than a request should keep: furigana for Spanish, glosses at `NONE`,
readings on Spanish glosses, more than 40 glosses for a long source. It sends all of it through the
same `GlossLocator` and `Result.for_request`. That way the dev and CI paths show the production
degrade behaviour (the truncated gloss list, omitted readings, the gates) instead of assuming it.
A source containing 《…》 cannot be annotated at all, and the fake is how dev and CI reach that
case.

## Errors

Anticipated failures are `Translation::Error` with a `Translation::ErrorCode`, returned in the
payload's `errors` as `TranslateError {code, message, retryable, retryAfterSeconds}`. Where they come
from: `Service`, `RateLimiter`, `ClaudeTranslator`, and `Translation::ClaudeErrorMapper` for SDK
and STS failures. The browser shows its own text for each code
(`frontend/app/src/lib/translateErrorMessage.ts`). The switch is exhaustive, so a new code does not
build until it has a message.

| Code | Retryable | Toast |
|---|---|---|
| `EMPTY_INPUT` | no | Enter some text to translate. |
| `INPUT_TOO_LONG` | no | That's over the length limit (10,000 characters of text, 2,000 of context)… |
| `SAME_LANGUAGE` | no | The source and target languages are the same. |
| `RATE_LIMITED` | yes | The server's message (which limit), plus "Try again in …" or "It resets in …" |
| `TIMEOUT` | yes | The translation took too long. Try again, or shorten the text. |
| `UPSTREAM_RATE_LIMITED` | yes | Claude is busy — try again in … |
| `UPSTREAM_OVERLOADED` | yes | Claude is temporarily overloaded. Try again shortly. |
| `UPSTREAM_ERROR` | yes | Claude had a problem. Try again. |
| `UPSTREAM_UNREACHABLE` | yes | Couldn't reach Claude. Try again. |
| `BUDGET_EXCEEDED` | no | This demo has reached its usage budget. Please let the owner know. |
| `SERVICE_MISCONFIGURED` | no | The translation service isn't configured correctly. Please let the owner know. |
| `REFUSED` | no | Claude declined to translate this text. |
| `OUTPUT_TOO_LONG` | no | The translation was too long to finish — try a shorter passage. |

Errors appear as a sonner toast, with a fresh id per attempt. **Try again** is offered only when
the code is retryable and no positive wait is known. With a known wait the message states it
instead, because clicking early would be refused and would count against the limits. Transport
failures (network, 5xx, `INTERNAL`) get a generic message and a retry. An ended session returns to
the access-code screen without a toast. Pending toasts are dismissed when the page unmounts.

## Translation eval

`backend/eval/cases.yml` has 19 cases. Each gives `from`, `to` and `text`, an optional `context`, an optional
`gloss_level` (default `notable`), and graders: `expect_any` (at least one case-insensitive regex
must match the translation) and `reject` (none may match). The graders are heuristics that catch
the wrong meaning, formality or region; read the printed output for the full picture. Categories:

- `ambiguity` (8): bat at a ballpark vs a cave (ES and JA), river bank, pitcher (baseball vs jug),
  *bomba* (pump), 結構です;
- `formality` (5): a report to a manager vs a friend, thanks to a CEO vs a brother, お疲れ様;
- `region` (4): car and computer vocabulary for Spain vs Mexico;
- `safety` (1): a prompt-injection source that must be translated, not obeyed;
- `length` (1): `notice-long-ja`, an EN→JA notice just inside `FURIGANA_LIMIT` at level `every`.
  This is the most expensive reply that still carries readings, and it exists to be timed.

Run against the real API (this costs money):

```sh
cd backend
TRANSLATOR=claude CLAUDE_AUTH=api_key ANTHROPIC_API_KEY=... bin/rails eval:translations
# EFFORTS=low,medium is the default; ONLY=bat-cave-es,notice-long-ja runs a subset
```

`backend/lib/tasks/eval.rake` builds one `ClaudeTranslator` per effort level and runs
`TranslationEval::Runner` (`backend/lib/translation_eval/`). For each case it prints PASS/FAIL, the
seconds taken, the translation, Claude's note, and what came with it ("furigana N chars" /
"furigana omitted" / "no furigana", gloss count, "(capped)"). Then it prints the pass count, p50,
p95 and max latency, and a pass count per category. The `length` category is left out of the
percentiles and timed on its own line, because the one case built to be slowest would otherwise
*be* the p95. The latency target is p95 under 10 s. Output tokens are not in the report;
`Claude::MessageCaller` logs them to the Rails log for the same run. An error, including an
unexpected exception, fails its case, not the whole run. `backend/test/lib/translation_eval/eval_test.rb`
checks that the set loads, has unique ids and covers every category and language.

For a single live check after a deploy, `bin/rails claude:auth_check` authenticates and translates
"Is this a bat?" at a baseball game (`backend/lib/tasks/claude.rake`).

## Tests

- Backend: `backend/test/services/translation/` (service, prompt, result, furigana, fake and Claude
  translators; the Claude one runs against stubbed HTTP), `backend/test/graphql/translate_mutation_test.rb`,
  `backend/test/services/translation_test.rb` (translator selection).
- Frontend: `frontend/app/src/pages/TranslatePage.test.tsx` (buffers, swap, out-of-date,
  annotations, errors), `frontend/app/src/lib/{annotateTranslation,furigana,translateErrorMessage}.test.ts`,
  and the two picker components' tests.

See [backend.md](backend.md) and [frontend.md](frontend.md) for how to run them.
