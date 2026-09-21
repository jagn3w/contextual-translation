# typed: strict
# frozen_string_literal: true

module Types
  class StartDiaryHelpThreadInputType < Types::BaseInputObject
    graphql_name "StartDiaryHelpThreadInput"

    argument :entry_id, ID
    argument :question, String, description: "What the learner wants to say, in their own language."
  end
end
