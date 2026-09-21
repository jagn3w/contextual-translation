# typed: strict
# frozen_string_literal: true

module Translation
  class Request < T::Struct
    const :source_text, String
    const :source_language, Language
    const :target_language, Language
    const :context, T.nilable(String)
    # How much of the translation to gloss. The GraphQL path always supplies this — the schema
    # publishes its own default and the mutation reads it (Types::TranslateInputType) — so this
    # default is for the callers that never touch GraphQL: the eval runner, and tests building a
    # Request directly. It is deliberately the same level, so neither door is the lenient one.
    const :gloss_level, GlossLevel, default: GlossLevel::NOTABLE
  end
end
