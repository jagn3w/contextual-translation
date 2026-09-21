# typed: strict
# frozen_string_literal: true

module Types
  class RequestDiaryHintInputType < Types::BaseInputObject
    graphql_name "RequestDiaryHintInput"

    argument :thread_id, ID, description: "A HELP thread."
  end
end
