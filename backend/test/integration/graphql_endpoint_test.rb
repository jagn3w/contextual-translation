# frozen_string_literal: true

require "test_helper"

class GraphqlEndpointTest < ActionDispatch::IntegrationTest
  test "executes a query for a signed-in session" do
    sign_in(label: "Panel")

    assert_equal({ "data" => { "viewer" => { "accessCodeLabel" => "Panel" } } }, graphql("{ viewer { accessCodeLabel } }"))
    assert_response :success
  end

  test "requires a session" do
    body = graphql("{ viewer { accessCodeLabel } }")

    assert_response :unauthorized
    assert_equal "UNAUTHENTICATED", body.dig("errors", 0, "extensions", "code")
  end

  test "rejects variables that are not a JSON object" do
    sign_in
    post_json "/graphql", { query: "{ viewer { accessCodeLabel } }", variables: "[1]" }

    assert_response :bad_request
    assert_equal "variables must be a JSON object", response.parsed_body.dig("errors", 0, "message")
  end

  test "rejects variables that are not valid JSON" do
    sign_in
    post_json "/graphql", { query: "{ viewer { accessCodeLabel } }", variables: "{nope" }

    assert_response :bad_request
  end

  test "rejects a query that isn't a string" do
    sign_in
    post_json "/graphql", { query: { nested: "x" } }

    assert_response :bad_request
  end

  test "a format suffix isn't routed" do
    sign_in
    post_json "/graphql.json", { query: "{ viewer { accessCodeLabel } }" }

    assert_response :not_found
  end

  test "health check responds without a session" do
    get "/up"

    assert_response :success
  end
end
