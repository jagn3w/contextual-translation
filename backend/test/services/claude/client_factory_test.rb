# frozen_string_literal: true

require "test_helper"

class Claude::ClientFactoryTest < ActiveSupport::TestCase
  WIF_ENV = {
    "CLAUDE_AUTH" => "wif",
    "AWS_REGION" => "us-east-1",
    "ANTHROPIC_FEDERATION_RULE_ID" => "fdrl_test",
    "ANTHROPIC_ORGANIZATION_ID" => "org_test",
    "ANTHROPIC_SERVICE_ACCOUNT_ID" => "svac_test",
    "ANTHROPIC_WORKSPACE_ID" => "wrkspc_test"
  }.freeze

  test "api_key mode needs a key" do
    assert_raises(Claude::ClientFactory::ConfigurationError) { Claude::ClientFactory.build({ "CLAUDE_AUTH" => "api_key" }) }
    assert_instance_of Anthropic::Client, Claude::ClientFactory.build({ "CLAUDE_AUTH" => "api_key", "ANTHROPIC_API_KEY" => "k" })
  end

  test "wif mode builds a client from the federation ids" do
    assert_instance_of Anthropic::Client, Claude::ClientFactory.build(WIF_ENV.to_h)
  end

  test "wif mode refuses credentials that would silently override it" do
    %w[ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_PROFILE].each do |name|
      error = assert_raises(Claude::ClientFactory::ConfigurationError) do
        Claude::ClientFactory.build(WIF_ENV.merge(name => "x"))
      end
      assert_includes error.message, name
    end
  end

  test "wif mode requires each federation id" do
    %w[AWS_REGION ANTHROPIC_FEDERATION_RULE_ID ANTHROPIC_ORGANIZATION_ID ANTHROPIC_SERVICE_ACCOUNT_ID].each do |name|
      error = assert_raises(Claude::ClientFactory::ConfigurationError) do
        Claude::ClientFactory.build(WIF_ENV.except(name))
      end
      assert_includes error.message, name
    end
  end

  test "rejects an unknown auth mode" do
    assert_raises(Claude::ClientFactory::ConfigurationError) { Claude::ClientFactory.build({ "CLAUDE_AUTH" => "oidc" }) }
  end

  test "wif requests exchange an STS identity token for an access token" do
    sts = Aws::STS::Client.new(region: "us-east-1", stub_responses: true)
    sts.stub_responses(:get_web_identity_token, web_identity_token: "sts.jwt.token")
    exchange = stub_request(:post, "https://api.anthropic.com/v1/oauth/token")
      .with { |req| JSON.parse(req.body).values_at("assertion", "federation_rule_id") == [ "sts.jwt.token", "fdrl_test" ] }
      .to_return(status: 200, headers: { "Content-Type" => "application/json" },
        body: { access_token: "anthropic-access-token", expires_in: 3600 }.to_json)
    messages = stub_request(:post, %r{\Ahttps://api\.anthropic\.com/v1/messages})
      .with(headers: { "Authorization" => "Bearer anthropic-access-token" })
      .to_return(status: 200, headers: { "Content-Type" => "application/json" }, body: {
        id: "m", type: "message", role: "assistant", model: "claude-opus-5",
        content: [ { type: "text", text: { translation: "Hola", notes: "" }.to_json } ],
        stop_reason: "end_turn", stop_sequence: nil, stop_details: nil, container: nil,
        usage: { input_tokens: 1, output_tokens: 1 }
      }.to_json)

    client = Claude::ClientFactory.build(WIF_ENV.to_h, sts:)
    result = Translation::ClaudeTranslator.new(client:).translate(
      Translation::Request.new(source_text: "Hello", source_language: Translation::Language::EN,
        target_language: Translation::Language::ES, context: nil)
    )

    assert_equal "Hola", result.text
    assert_requested exchange
    assert_requested messages
  end
end
