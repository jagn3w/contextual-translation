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
        context: input.context,
        # `glossLevel` is nullable with a default in the committed schema, so an explicit
        # `glossLevel: null` is a legal query and arrives here as nil, overriding the default.
        # Coerce rather than tighten the argument to non-null: that would turn those queries into
        # validation errors instead of the omitted-argument behaviour they plainly mean, and the
        # schema is the client's codegen contract (design D1.2).
        gloss_level: input.gloss_level || Types::TranslateInputType.gloss_level_default
      )
      result = Translation::Service.new.call(request, session: context.fetch(:current_session))
      {
        translation: {
          text: result.text,
          notes: result.notes,
          furigana: result.furigana,
          glosses: result.glosses,
          glosses_truncated: result.glosses_truncated,
          readings_omitted: result.readings_omitted,
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
