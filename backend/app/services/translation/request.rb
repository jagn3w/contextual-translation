# typed: strict
# frozen_string_literal: true

module Translation
  class Request < T::Struct
    const :source_text, String
    const :source_language, Language
    const :target_language, Language
    const :context, T.nilable(String)
  end
end
