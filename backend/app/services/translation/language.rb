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
