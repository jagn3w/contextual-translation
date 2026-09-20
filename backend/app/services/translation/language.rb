# typed: strict
# frozen_string_literal: true

module Translation
  class Language < T::Enum
    extend T::Sig

    enums do
      EN = new("en")
      ES = new("es")
      JA = new("ja")
    end

    # Whether the language marks word boundaries with spaces. It does not for Japanese, where a
    # word is legitimately a substring of a longer run of characters, so a gloss can only be
    # located by plain substring search there (design D2.3).
    sig { returns(T::Boolean) }
    def space_delimited?
      case self
      when EN, ES then true
      when JA then false
      else T.absurd(self)
      end
    end

    sig { returns(String) }
    def english_name
      case self
      when EN then "English"
      when ES then "Spanish"
      when JA then "Japanese"
      else T.absurd(self)
      end
    end
  end
end
