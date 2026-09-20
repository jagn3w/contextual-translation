# typed: strict
# frozen_string_literal: true

module Translation
  # How much of the translation to gloss, chosen per request (design D2.3). The serialized value
  # is what goes in the prompt's <gloss_level> tag, so these spellings are part of the contract
  # with Claude as well as with the UI.
  class GlossLevel < T::Enum
    enums do
      # No glosses at all.
      NONE = new("none")
      # Only the words worth remarking on: the ambiguous, idiomatic or register-carrying ones.
      NOTABLE = new("notable")
      # Every content word and set phrase — the dictionary-popup reading.
      EVERY = new("every")
    end
  end
end
