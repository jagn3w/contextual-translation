# typed: strict
# frozen_string_literal: true

class ContextualTranslateSchema < GraphQL::Schema
  query(Types::QueryType)
  mutation(Types::MutationType)

  use GraphQL::Dataloader

  # Limit the depth and size of incoming queries.
  max_depth(15)
  max_query_string_tokens(5000)
  max_complexity(150) # one translate (100) plus ordinary fields
  validate_max_errors(100)

  # The catch-all for failures nobody planned for (design D3.3): log the details, and give the
  # client a generic message plus a short reference to find them in the logs.
  rescue_from(StandardError) do |error, _object, _arguments, _context, _field|
    reference = SecureRandom.hex(4)
    Rails.logger.error("GraphQL INTERNAL ref=#{reference} #{error.class}: #{error.message}\n" \
                       "#{error.backtrace&.first(10)&.join("\n")}")
    raise GraphQL::ExecutionError.new(
      "Something unexpected went wrong.",
      extensions: { "code" => "INTERNAL", "reference" => reference }
    )
  end
end
