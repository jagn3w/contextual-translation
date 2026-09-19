# typed: strict
# frozen_string_literal: true

module Mutations
  # Translates text with context (design D3.2). Anticipated failures come back in `errors`;
  # anything else becomes a top-level INTERNAL error (D3.3).
  class Translate < Mutations::BaseMutation
    graphql_name "Translate"

    argument :input, Types::TranslateInputType

    type Types::TranslatePayloadType, null: false

    sig { params(input: T.untyped).returns(T::Hash[Symbol, T.untyped]) }
    def resolve(input:)
      request = Translation::Request.new(
        source_text: input.source_text,
        source_language: input.source_language,
        target_language: input.target_language,
        context: input.context
      )
      result = Translation::Service.new.call(request, session: context.fetch(:current_session))
      {
        translation: {
          text: result.text,
          notes: result.notes,
          source_language: request.source_language,
          target_language: request.target_language
        },
        errors: []
      }
    rescue Translation::Error => e
      { translation: nil, errors: [ e ] }
    end
  end
end
