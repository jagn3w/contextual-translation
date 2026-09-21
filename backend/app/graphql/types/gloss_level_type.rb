# typed: strict
# frozen_string_literal: true

module Types
  class GlossLevelType < Types::BaseEnum
    graphql_name "GlossLevel"
    description "How much of a translation to gloss with per-word definitions."

    value "NONE", "No glosses at all.", value: Translation::GlossLevel::NONE
    value "NOTABLE", "Only the words worth remarking on: ambiguous, idiomatic or register-carrying ones.",
      value: Translation::GlossLevel::NOTABLE
    value "EVERY", "Every content word and set phrase, skipping function words.",
      value: Translation::GlossLevel::EVERY
  end
end
