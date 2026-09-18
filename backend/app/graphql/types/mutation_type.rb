# typed: strict
# frozen_string_literal: true

module Types
  class MutationType < Types::BaseObject
    field :translate, mutation: Mutations::Translate
  end
end
