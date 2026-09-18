# frozen_string_literal: true

# Helpers for integration tests that talk to the API like the browser does: JSON bodies and the
# app's own Origin header (design D4.2).
module SessionHelpers
  ORIGIN = "http://www.example.com"

  def json_headers
    { "Origin" => ORIGIN }
  end

  def post_json(path, params = {}, headers: {})
    post path, params:, headers: json_headers.merge(headers), as: :json
  end

  def delete_json(path, headers: {})
    delete path, headers: json_headers.merge(headers), as: :json
  end

  # Creates an access code and signs in with it; returns [record, plaintext].
  def sign_in(label: "Test")
    record, plaintext = AccessCode.generate!(label:)
    post_json "/api/session", { code: plaintext }
    assert_response :no_content
    [ record, plaintext ]
  end

  def graphql(query, variables: {}, headers: {})
    post_json("/graphql", { query:, variables: }, headers:)
    response.parsed_body
  end
end
