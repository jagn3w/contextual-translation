# typed: strict
# frozen_string_literal: true

module Translation
  class Request < T::Struct
    const :source_text, String
    const :source_language, Language
    const :target_language, Language
    const :context, T.nilable(String)
    # How much of the translation to gloss. NOTABLE unless the caller says otherwise, so a
    # request that predates the picker still gets the useful handful of definitions.
    const :gloss_level, GlossLevel, default: GlossLevel::NOTABLE
  end
end
