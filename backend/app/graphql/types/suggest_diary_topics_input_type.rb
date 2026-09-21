# typed: strict
# frozen_string_literal: true

module Types
  class SuggestDiaryTopicsInputType < Types::BaseInputObject
    graphql_name "SuggestDiaryTopicsInput"

    argument :language, Types::LanguageType
    argument :notes_language, Types::LanguageType
    argument :body, String, required: false,
      description: "What the learner has written so far, saved or not. When it has text, the ideas are " \
                   "follow-ups that build on it rather than fresh topics."
  end
end
