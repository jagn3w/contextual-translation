# typed: strict
# frozen_string_literal: true

class ContextualTranslateSchema < GraphQL::Schema
  query(Types::QueryType)

  use GraphQL::Dataloader

  # Limit the depth and size of incoming queries.
  max_depth(15)
  max_query_string_tokens(5000)
  validate_max_errors(100)
end
