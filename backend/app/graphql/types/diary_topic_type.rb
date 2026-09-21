# typed: strict
# frozen_string_literal: true

module Types
  class DiaryTopicType < Types::BaseObject
    graphql_name "DiaryTopic"
    description "An idea to write about."

    field :prompt, String, null: false, description: "The prompt, in the entry's language."
    field :gloss, String, null: false, description: "Its meaning, in the notes language."
  end
end
