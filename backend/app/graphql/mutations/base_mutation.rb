# typed: strict
# frozen_string_literal: true

module Mutations
  # Plain (non-Relay) mutations: each declares its own input and payload types so the schema
  # matches design D3.2 exactly.
  class BaseMutation < GraphQL::Schema::Mutation
    extend T::Sig

    argument_class Types::BaseArgument
    field_class Types::BaseField
    object_class Types::BaseObject
  end
end
