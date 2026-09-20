# typed: strict
# frozen_string_literal: true

module Types
  class TranslationType < Types::BaseObject
    graphql_name "Translation"

    field :text, String, null: false
    field :notes, String, description: "Claude's note on the meaning, formality and regional variety it chose."
    field :furigana, String,
      description: "For Japanese, `text` repeated with a reading in double angle brackets after each run of " \
                   "kanji (漢字《かんじ》); removing every 《…》 group gives back `text`. Null when there is none."
    field :glosses, [ Types::GlossType ], null: false,
      description: "Words of `text` worth defining, in the order they appear in it, with " \
                   "non-overlapping spans. Empty when there is nothing to gloss."
    # False cannot promise the list is complete, and must not say so: entries whose word the
    # backend could not locate in `text` are dropped too, and this flag — the cap's flag — stays
    # false for them, correctly. There is no separate field for that loss on purpose: a gap in
    # the middle of a sentence is indistinguishable from "this word was not worth glossing",
    # which is the ordinary state at the NOTABLE level, so there is no honest sentence to show a
    # reader about it. The drop is logged instead (ClaudeTranslator#log_gloss_loss).
    field :glosses_truncated, Boolean, null: false,
      description: "True when more glosses were offered than the cap allows and the extras were dropped, so " \
                   "`glosses` runs out before the end of `text`. False means only that the cap did not cut the " \
                   "list off: `glosses` is never a complete index of `text`, and a word without one is ordinary."
    field :readings_omitted, Boolean, null: false,
      description: "True when the source was too long for kana readings to be asked for at all, so `furigana` " \
                   "is null because the request gave the readings up rather than because `text` has no kanji. " \
                   "False for every target but Japanese, where readings are not expected in the first place."
    field :source_language, Types::LanguageType, null: false
    field :target_language, Types::LanguageType, null: false
  end
end
