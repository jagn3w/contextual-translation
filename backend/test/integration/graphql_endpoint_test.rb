# frozen_string_literal: true

require "test_helper"

class GraphqlEndpointTest < ActionDispatch::IntegrationTest
  test "executes a query" do
    post "/graphql", params: { query: "{ ping }" }, as: :json

    assert_response :success
    assert_equal({ "data" => { "ping" => "pong" } }, response.parsed_body)
  end

  test "rejects variables that are not a JSON object" do
    post "/graphql", params: { query: "{ ping }", variables: "[1]" }, as: :json

    assert_response :bad_request
    assert_equal "variables must be a JSON object", response.parsed_body.dig("errors", 0, "message")
  end

  test "rejects variables that are not valid JSON" do
    post "/graphql", params: { query: "{ ping }", variables: "{nope" }, as: :json

    assert_response :bad_request
  end

  test "health check responds" do
    get "/up"

    assert_response :success
  end
end
