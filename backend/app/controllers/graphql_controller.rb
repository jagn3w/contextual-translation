# typed: strict
# frozen_string_literal: true

class GraphqlController < ApplicationController
  class InvalidVariables < StandardError; end

  rescue_from InvalidVariables do |error|
    render json: { errors: [ { message: error.message } ] }, status: :bad_request
  end

  # Every operation requires a session (design D3.1). The body is GraphQL-shaped so clients
  # handle it like any other top-level error (D3.3).
  before_action :require_session

  sig { void }
  def execute
    result = ContextualTranslateSchema.execute(
      params[:query],
      variables: prepare_variables(params[:variables]),
      context: { current_session: current_session },
      operation_name: params[:operationName]
    )
    render json: result
  end

  private

  sig { void }
  def require_session
    return if current_session

    render json: { errors: [ { message: "Not signed in", extensions: { code: "UNAUTHENTICATED" } } ] },
      status: :unauthorized
  end

  # Variables arrive as a JSON object (application/json requests) or, rarely, a JSON string.
  # GraphQL-Ruby validates variable names and types against the schema; this only ensures the
  # container is an object.
  sig { params(variables_param: T.untyped).returns(T::Hash[String, T.untyped]) }
  def prepare_variables(variables_param)
    case variables_param
    when nil
      {}
    when ActionController::Parameters
      variables_param.to_unsafe_hash
    when String
      return {} if variables_param.blank?

      parsed = JSON.parse(variables_param)
      raise InvalidVariables, "variables must be a JSON object" unless parsed.is_a?(Hash)

      parsed
    else
      raise InvalidVariables, "variables must be a JSON object"
    end
  rescue JSON::ParserError
    raise InvalidVariables, "variables is not valid JSON"
  end
end
