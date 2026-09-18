# typed: strict
# frozen_string_literal: true

class GraphqlController < ApplicationController
  sig { void }
  def execute
    result = ContextualTranslateSchema.execute(
      params[:query],
      variables: prepare_variables(params[:variables]),
      context: {},
      operation_name: params[:operationName]
    )
    render json: result
  end

  private

  # Variables arrive as a JSON object (application/json requests) or, rarely, a JSON string.
  sig { params(variables_param: T.untyped).returns(T::Hash[String, T.untyped]) }
  def prepare_variables(variables_param)
    case variables_param
    when String
      variables_param.present? ? JSON.parse(variables_param) : {}
    when ActionController::Parameters
      # GraphQL-Ruby validates variable names and types against the schema.
      variables_param.to_unsafe_hash
    when nil
      {}
    else
      raise ArgumentError, "Unexpected variables parameter: #{variables_param.class}"
    end
  end
end
