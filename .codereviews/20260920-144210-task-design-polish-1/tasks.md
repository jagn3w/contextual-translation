# Code review — task/design-polish @ 2026-09-20 15:01

Base: 8f360c8..HEAD · HEAD: b79822f · Effort: low · Reviewers: 3 · Findings: 15 for this change (of 16 raw, 0 refuted) · Pre-existing filed to the backlog: 0

## Must-fix

- [ ] A successful response overwrites the source buffer with the text that was sent, silently discarding whatever the user typed into the still-editable textarea while the request was in flight. — frontend/app/src/pages/TranslatePage.tsx:257 !p1
  Type "Is this a bat?", click Update Translation. The button disables but the source `<textarea>`
  does not (only the button and the swap control take `disabled={loading}`), so during the 5-20 s
  Opus call the user keeps editing to "Is this a baseball bat, or an animal?" and `editSource`
  writes that into `buffers.EN.input`. The response lands and runs `withBuffer(current,
  sent.source, { input: sent.text, target: sent.text })`, resetting `buffers.EN.input` back to "Is
  this a bat?". The edit is gone with no undo (React controlled value, so Ctrl+Z will not bring it
  back) and no indication anything was dropped. `main`'s handler (TranslatePage.tsx:147 there)
  only called `setTranslation` and never wrote the source text, so the edit survived and
  `sourceEdited` marked the result stale — the regression is in the diff.
  Fix: Only reset the source buffer when its `input` still equals `sent.text` at write time (the
  functional updater already has `current` to compare against); leave a changed draft alone and
  let it show as stale. The target buffer can keep its unconditional write.

- [ ] Nothing stops `<rt>` text entering the clipboard, so copying an annotated Japanese translation yields the kana interleaved with the sentence — the opposite of what the comment above it claims. — frontend/app/src/pages/TranslatePage.tsx:77 !p1
  Translate "Nice weather today" EN→JA, select the result pane and copy: browsers include ruby
  annotation text in copied plain text, so the clipboard gets 今日きょうは良よい天気てんきですね rather than
  今日は良い天気ですね. Pasting that into the email the user came here to write is garbage, and furigana is
  unconditional for a Japanese target, so this is every copy of the flagship pair. The comment at
  TranslatePage.tsx:66 claims "what a user selects and copies is the plain sentence"; the test
  helper `textWithoutReadings` (TranslatePage.test.tsx:43, "the plain translation, which is what
  is copied") deletes exactly the `<rt>` nodes a real copy would include, so it cannot fail for
  this reason.
  Fix: Add `rt { user-select: none }` (the standard furigana-site fix) alongside the ruby styling,
  and reword the comment and test helper so they stop claiming a copy behaviour the DOM assertion
  does not cover. The browser behaviour is well known but was not demonstrated in this repo — one
  manual copy settles it before you spend more than the one CSS line.

- [ ] When a gloss boundary cuts a kanji run in two, the whole run's reading is re-attached to the first half alone, so a compound's reading is displayed over only part of it and the rest gets none. — frontend/app/src/lib/annotateTranslation.ts:135 !p1
  The prompt asks for one reading after "each run of kanji", so 東京駅に行きます comes back as one segment
  東京駅 / とうきょうえき. At the default level NOTABLE Claude also glosses 東京 on its own; the backend
  locates it at startsAt 0, length 2 and passes it through, since glosses and furigana are
  validated independently and nothing checks that a gloss span lies inside a ruby base. `spansOf`
  cuts the segment into [東京, 駅]; both hold kanji, so `pieces.find(hasKanji)` takes the first and
  the page renders <ruby>東京<rt>とうきょうえき</rt></ruby>駅 — the reader is taught that 東京 reads とうきょうえき
  and 駅 has no reading. Same for 日本語学校 glossed as 日本語. The committed test "splits a ruby segment a
  gloss ends inside" asserts this shape (てんき over 天 alone), so the behaviour is not in doubt; the
  comment's rule — give the reading to "the piece that kept the kanji" — simply has no answer when
  both pieces did.
  Fix: When a split leaves kanji in more than one piece, drop the reading for that segment (render
  both pieces plain) rather than asserting it over one half — or refuse to split a ruby base at
  all, skipping the gloss whose span cuts one.

## Concern

- [ ] The 16k output budget and 30 s/55 s deadlines were sized for {translation, notes}; furigana repeats the whole translation plus readings and glosses add up to 40 entries, so long Japanese translations can now fail outright where they used to succeed. — backend/app/services/translation/claude_translator.rb:13 !p2
  A 6,000-character English source (well inside the documented 10,000 limit) yields a Japanese
  translation of ~3,000 characters. Before this change the model emitted translation + notes; now
  it must also emit `furigana` — the same translation with a kana reading after every kanji run,
  ~1.6× its length — plus up to 40 gloss entries, all against an unchanged MAX_TOKENS = 16_000
  that adaptive thinking also draws on, and an unchanged 30 s SDK timeout / 55 s deadline with no
  retry on timeout by design. When it blows either budget the user loses the whole translation,
  not just the annotations, and unlike glosses (glossLevel NONE) furigana cannot be switched off.
  The multiplier here is estimated, not measured — the direction is certain, the threshold is not,
  and the eval runner would settle it cheaply.
  Fix: Re-measure with the eval runner and size MAX_TOKENS and the deadline for the new output
  shape, or make furigana conditional (only below some translation length, or a request flag) so a
  long Japanese translation degrades to plain text instead of failing.

- [ ] A gloss is located with a plain substring search, so a short glossed word is pinned to the first place it occurs inside a longer, different word earlier in the translation — and the cursor jump then drops later glosses. — backend/app/services/translation/claude_translator.rb:254 !p2
  English target, level NOTABLE. Translation "Send the message before the age of consent." with
  one gloss {text: "age"}: `translation.index("age", 0)` returns 13 — inside "mess**age**" — not
  27, so the UI underlines the tail of "message" and pops "legal adulthood" over it. Same for
  {text: "port"} in "It is important to reach the port." → index 8. It cascades: `cursor` jumps to
  the false match's end, so any later gloss whose real occurrence lies between the false and the
  true position is dropped. The commit's stated invariant (in range, in order, non-overlapping)
  still holds — the span is valid, just over the wrong characters — which is why nothing catches
  it.
  Fix: For space-delimited targets, prefer the first occurrence whose neighbouring characters are
  not word characters, falling back to the raw index and then to dropping; Japanese, which has no
  such boundaries, keeps today's behaviour.

- [ ] The stale state's blanket `opacity-60` over the newly darkened `bg-frame` drops the translation text to roughly 3.3:1 — below WCAG AA, and worse than the same state was before the frame was darkened. — frontend/app/src/pages/TranslatePage.tsx:362 !p2
  Translate "Hello" to Japanese, then edit the source — a routine step. `stale` becomes true and
  the result pane takes `opacity-60`, compositing the whole subtree against the white canvas: the
  translation (`text-ink` #37352f on `--color-frame` #efefeb) renders as ~#878581 on ~#f5f5f3 ≈
  3.33:1, and Claude's note (`text-frame-muted`) at ~2.3:1. At 18px non-bold, AA needs 4.5:1. The
  same state on the old `bg-surface/60` pane computed to ~3.60:1, so taking the frame to lightness
  93 measurably worsened it — and defeats the `--color-frame-muted` token added in the same change
  for exactly this reason. index.css:17 asserts secondary text on the frame "still clears WCAG
  AA", which the stale state breaks for both primary and secondary text.
  Fix: Signal staleness with something other than a whole-subtree opacity — dim the frame
  background and keep the ink at full strength, or use a marker/label — and pick a value whose
  composited contrast you can state the way the token comments already do.

- [ ] Truncation at the 40-gloss cap is invisible to everyone: the reader of a long translation sees definitions simply stop, and the "Dropped N of M" log excludes the truncated entries because `break` precedes the `dropped` increment. — backend/app/services/translation/claude_translator.rb:240 !p2
  A user pastes a 200-word email (the app accepts 10,000 code points), picks "Definitions: All" —
  documented as "Every content word and set phrase" — and gets ~40 underlined words at the top of
  the paragraph and none after, indistinguishable from "Claude judged the rest not worth
  glossing". On the operator side, 60 well-formed glosses make `glosses_from` break at index 40
  with `dropped == 0`, so `dropped.positive?` is false and nothing is logged at all; with one
  malformed entry among the 60 the line reads "Dropped 1 of 60 glosses Claude returned" while 20
  were discarded. The cap itself is a deliberate decision; that it fires silently at both ends is
  not recorded as one anywhere.
  Fix: Count the truncated remainder into `dropped` (or log the cap hit separately) so the number
  matches what was discarded, and surface the same fact to the reader — a flag on the payload and
  a line in the result pane — or name the level for what it delivers.

- [ ] FakeTranslator ignores `request.gloss_level` entirely, so on the dev and CI path the picker's setting does nothing and the one behaviour the feature exists to control is untestable by the gate. — backend/app/services/translation/fake_translator.rb:32 !p2
  `bin/dev` writes `TRANSLATOR=fake` (bin/dev:68). A developer translates EN→JA, chooses
  "Definitions: None", and the next response still carries two glosses ([JA] and the last word)
  with two underlined, hoverable words — the opposite of what was asked and of what
  ClaudeTranslator does (claude_translator.rb:222 returns [] for NONE). "All" likewise changes
  nothing, and EN→ES gets no glosses at any level, so the feature is invisible on the dev path for
  two of three languages. The only end-to-end level test (translate_mutation_test.rb:71) swaps in
  a hand-rolled recording translator that records the level and delegates to the fake, so it
  asserts plumbing, never behaviour. Project convention is explicit that the fake stays feature-
  complete or the feature is untestable.
  Fix: Have `glosses_for` return [] for GlossLevel::NONE, vary its output between NOTABLE and
  EVERY, and emit at least one gloss for non-Japanese targets, with a fake_translator_test case
  per level.

## Nit

- [ ] An explicit `glossLevel: null` — legal under the committed schema and under the generated TS input type — reaches `Request.new(gloss_level: nil)` and raises a Sorbet TypeError, surfacing as INTERNAL instead of defaulting to NOTABLE. — backend/app/graphql/mutations/translate.rb:21 !p3
  `translate(input: {sourceText: "hi", sourceLanguage: EN, targetLanguage: JA, glossLevel:
  null})`. graphql-ruby applies `default_value` only when the key is absent; an explicit null
  passes through as nil (the finder confirmed this against a minimal schema). `const :gloss_level,
  GlossLevel, default: NOTABLE` then raises `TypeError: Can't set Request.gloss_level to nil`,
  which `rescue Translation::Error` does not catch, so the caller gets a top-level INTERNAL and
  production logs an exception — for an input both `schema.graphql` and `gql/graphql.ts`
  (`glossLevel?: GlossLevel | null | undefined`) advertise as legal, and D3.3 reserves INTERNAL
  for failures genuinely not planned for. Demoted from the finder's `concern`: the only client is
  this frontend, which always sends a level, so no normal-use path produces the null.
  Fix: Make the argument non-null in TranslateInputType (keeping the default), or coerce nil to
  GlossLevel::NOTABLE at the resolver before building the Request — and add a mutation test
  sending explicit null.

- [ ] The kanji character class omits CJK compatibility ideographs, U+3007 〇 and astral (Extension B) kanji, so a reading that follows one of them is placed over the wrong base. — frontend/app/src/lib/furigana.ts:15 !p3
  For the name 山﨑 (﨑 is U+FA11, common in real Japanese names) Claude returns 山﨑《やまざき》さん.
  KANJI_RUN, anchored at the end of `pending`, fails because 﨑 is outside [々〆ヶ㐀-䶿一-鿿], so `baseOf`
  falls to the single-character fallback: 山 renders plain and <ruby>﨑<rt>やまざき</rt></ruby>. Same
  for 二〇二五年《にせんにじゅうごねん》 (〇 is U+3007), where the reading lands over 二五年, and 𠮟責 (U+20B9F) where
  only 責 carries it. The joined text still equals the translation, so annotateTranslation's
  mismatch guard does not catch it — the text is right and only the placement is wrong.
  Fix: Extend the class to cover U+F900–U+FAFF, U+3007, ヵ and the astral ideograph planes (the
  regex already has the `u` flag, so \u{20000}-\u{2FA1F} works), and add a furigana.test.ts case
  for a compatibility ideograph.

- [ ] `showingResponseOutput` gates furigana and glosses on the source *picker* still matching, so changing the source language strips the ruby and the gloss buttons off Japanese text that has not changed at all. — frontend/app/src/pages/TranslatePage.tsx:168 !p3
  Translate English → Japanese: the pane shows 今日《きょう》は良《よ》い天気《てんき》ですね as three `<ruby>` elements
  plus gloss buttons. Open the Source picker and choose Spanish — a normal next step when the user
  wants to translate Spanish into the same Japanese — and `sourceLanguage` no longer equals
  `translation.sourceLanguage`, so `responseFurigana` and `responseGlosses` fall back to
  null/empty and the identical Japanese string re-renders flat. Picking English again brings them
  back. The readings and offsets are keyed to `translation.text`, which the same line already
  checks; the source-picker term is stricter than what the annotations actually depend on.
  Fix: Key the annotations on the pane's text and target language alone (`targetLanguage ===
  translation.targetLanguage && resultText === translation.text`); the separate `stale`
  computation is what should carry "the pickers moved on".

- [ ] `reading` is kept for any target language, contradicting both the struct doc ("nil for every other target") and the GraphQL description — unlike `furigana`, which is gated on the target being Japanese. — backend/app/services/translation/claude_translator.rb:257 !p3
  Target Spanish. The output schema makes `reading` a required property of every gloss entry and
  describes it as "empty string otherwise", but models routinely fill a required string; Claude
  returns {text: "bate", reading: "BA-te", meaning: "bate de béisbol"}. `gloss_from` stores it,
  `Gloss#reading` is non-nil for a Spanish target, and GlossCard renders it beside the headword as
  if it were a kana reading. `furigana_from`, two methods above, does check
  `request.target_language == Language::JA`; `gloss_from` does not.
  Fix: Drop the reading unless the target language is Japanese, the way furigana_from does — or
  change the two descriptions to say what the code actually returns.

- [ ] `className="truncate"` on `Select.Value` is silently discarded by Radix, so the truncation the new comment documents does not exist — and GlossLevelSelect.tsx:45 repeats the no-op. — frontend/app/src/components/LanguageSelect.tsx:21 !p3
  `@radix-ui/react-select@2.3.7` dist/index.mjs line 236 destructures `const { __scopeSelect,
  className, style, children, placeholder = "", ...valueProps } = props;` and renders
  `<Primitive.span {...valueProps} style={{pointerEvents:"none"}}>`, so className never reaches
  the DOM. The span keeps `min-width:auto` as a flex child with no `overflow-hidden`/ellipsis, and
  on a viewport too narrow for a language name the name is clipped hard by the section's
  `overflow-hidden` rather than ellipsised — the exact failure the comment on lines 15-16 says it
  prevents. Today's three names still fit at ~360px, so the harm is latent and only the claim is
  false.
  Fix: Move the truncation classes somewhere Radix passes them through — a `<span
  className="truncate">` inside `Select.Value`, or `overflow-hidden` plus `min-w-0` on the trigger
  — and fix the sibling in GlossLevelSelect at the same time.

- [ ] The 40-gloss cap is written as a literal in the prompt and the schema description beside the MAX_GLOSSES constant that claims to match them, so changing the constant is a silent no-op. — backend/app/services/translation/prompt.rb:68 !p3
  Someone raises `MAX_GLOSSES` to 60 (claude_translator.rb:27, comment "matching the cap the
  prompt states"). The system prompt still says "stop at 40 entries" (prompt.rb:68) and the
  array's schema description still says "at most 40" (prompt.rb:93), so Claude keeps returning 40
  and the change does nothing. No test asserts the prompt and the constant agree. Stays a nit: the
  cost is hypothetical — nothing has yet had to change and got it wrong.
  Fix: Interpolate the cap into the prompt and the schema description from one constant (move
  MAX_GLOSSES to Prompt, or have Prompt reference it).

- [ ] The only test of the auto-grow hook asserts its jsdom no-op, so the invariant its own comment calls out — collapse to `auto` before measuring, or the box never shrinks — has no coverage. — frontend/app/src/lib/useAutoGrowTextarea.ts:17 !p3
  TranslatePage.test.tsx:173 ("leaves a pane's height to CSS where nothing is laid out") types
  into the source pane and asserts `source.style.height === ""`. That passes if the hook is
  correct, if the `height = "auto"` line is deleted, if the resize listener is removed, and even
  if the hook is not wired to the textarea at all, since jsdom reports `scrollHeight` 0 either
  way. Delete `textarea.style.height = "auto"` — the exact bug the comment on lines 13-15 exists
  to prevent — and `bin/check` stays green, which with `resize-none overflow-hidden` on the pane
  means text can be hidden with no scrollbar to reveal it.
  Fix: Stub `scrollHeight` on `HTMLTextAreaElement.prototype` (a getter derived from the current
  `style.height`) in one focused test and assert the hook both grows and shrinks; keep the
  existing test as the fallback case.

## Filed elsewhere

None. Every finding in this run is `introduced` or `aggravated` — this change is where
each of them gets fixed, so nothing was filed to the backlog.
