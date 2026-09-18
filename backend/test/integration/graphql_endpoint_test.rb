# frozen_string_literal: true

require "test_helper"

class GraphqlEndpointTest < ActionDispatch::IntegrationTest
  test "executes a query for a signed-in session" do
    sign_in

    assert_equal({ "data" => { "ping" => "pong" } }, graphql("{ ping }"))
    assert_response :success
  end

  test "requires a session" do
    body = graphql("{ ping }")

    assert_response :unauthorized
    assert_equal "UNAUTHENTICATED", body.dig("errors", 0, "extensions", "code")
  end

  test "rejects variables that are not a JSON object" do
    sign_in
    post_json "/graphql", { query: "{ ping }", variables: "[1]" }

    assert_response :bad_request
    assert_equal "variables must be a JSON object", response.parsed_body.dig("errors", 0, "message")
  end

  test "rejects variables that are not valid JSON" do
    sign_in
    post_json "/graphql", { query: "{ ping }", variables: "{nope" }

    assert_response :bad_request
  end

  test "health check responds without a session" do
    get "/up"

    assert_response :success
  end
end
