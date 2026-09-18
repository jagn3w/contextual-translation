# frozen_string_literal: true

require "test_helper"

class GraphqlEndpointTest < ActionDispatch::IntegrationTest
  test "executes a query" do
    post "/graphql", params: { query: "{ ping }" }, as: :json

    assert_response :success
    assert_equal({ "data" => { "ping" => "pong" } }, response.parsed_body)
  end

  test "health check responds" do
    get "/up"

    assert_response :success
  end
end
