# typed: strict
# frozen_string_literal: true

module Types
  class BaseObject < GraphQL::Schema::Object
    extend T::Sig

    field_class Types::BaseField
  end
end
