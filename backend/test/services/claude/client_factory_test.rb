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

  setup { @refreshers = [] }
  teardown { @refreshers.each(&:stop) }

  test "api_key mode needs a key" do
    assert_raises(Claude::ClientFactory::ConfigurationError) { Claude::ClientFactory.build({ "CLAUDE_AUTH" => "api_key" }) }
    assert_instance_of Anthropic::Client, Claude::ClientFactory.build({ "CLAUDE_AUTH" => "api_key", "ANTHROPIC_API_KEY" => "k" })
  end

  test "wif mode builds a client from the federation ids, with background token refresh" do
    client = Claude::ClientFactory.build(WIF_ENV.to_h)

    assert_instance_of Anthropic::Client, client
    assert_instance_of Claude::TokenRefresher, client.credentials
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

  test "an STS network failure during WIF becomes UPSTREAM_UNREACHABLE" do
    sts = Aws::STS::Client.new(region: "us-east-1", stub_responses: true)
    sts.stub_responses(:get_web_identity_token, Seahorse::Client::NetworkingError.new(Errno::ECONNRESET.new))
    client = build_wif(sts)

    error = assert_raises(Translation::Error) { translate(client) }

    assert_equal Translation::ErrorCode::UPSTREAM_UNREACHABLE, error.code
  end

  test "a 401 has the refresher fetch a new WIF token, then retries once with it" do
    exchange = stub_exchange(token_response("revoked"), token_response("fresh"))
    stub_messages("revoked", status: 401, body: auth_error_body)
    fresh = stub_messages("fresh", status: 200, body: message_body)

    result = translate(build_wif(ok_sts))

    assert_equal "Hola", result.text
    assert_requested exchange, times: 2 # none from the SDK's own token cache
    assert_requested fresh, times: 1
  end

  test "a failed refresh after a 401 fails fast and leaves nothing pending for the next request" do
    exchange = stub_exchange(token_response("revoked"),
      { status: 400, headers: { "Content-Type" => "application/json" }, body: { error: "invalid_grant" }.to_json })
    rejected = stub_messages("revoked", status: 401, body: auth_error_body)
    client = build_wif(ok_sts)
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    2.times do
      error = assert_raises(Translation::Error) { translate(client) }
      assert_equal Translation::ErrorCode::SERVICE_MISCONFIGURED, error.code
    end

    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 2.0
    assert_requested exchange, times: 2 # the warmer is backing off; requests never fetch
    assert_requested rejected, times: 2
    assert_equal false, client.token_cache.instance_variable_get(:@next_force)
  end

  test "no time left for credentials means UPSTREAM_UNREACHABLE, without calling Claude" do
    gate = Queue.new
    provider = Object.new
    provider.define_singleton_method(:call) { gate.pop }
    refresher = Claude::TokenRefresher.new(provider:)
    @refreshers << refresher
    client = Anthropic::Client.new(credentials: refresher, max_retries: 0, timeout: 30)
    now = 0.0
    translator = Translation::ClaudeTranslator.new(client:, clock: -> { now += 50.0 })

    error = assert_raises(Translation::Error) { translator.translate(hello) }

    assert_equal Translation::ErrorCode::UPSTREAM_UNREACHABLE, error.code
    assert_not_requested :post, %r{api\.anthropic\.com}
  end

  test "wif requests exchange an STS identity token for an access token" do
    exchange = stub_request(:post, "https://api.anthropic.com/v1/oauth/token")
      .with { |req| JSON.parse(req.body).values_at("assertion", "federation_rule_id") == [ "sts.jwt.token", "fdrl_test" ] }
      .to_return(token_response("anthropic-access-token"))
    messages = stub_messages("anthropic-access-token", status: 200, body: message_body)

    result = translate(build_wif(ok_sts))

    assert_equal "Hola", result.text
    assert_requested exchange
    assert_requested messages
  end

  private

  def build_wif(sts)
    Claude::ClientFactory.build(WIF_ENV.to_h, sts:).tap { |client| @refreshers << client.credentials }
  end

  def ok_sts
    Aws::STS::Client.new(region: "us-east-1", stub_responses: true).tap do |sts|
      sts.stub_responses(:get_web_identity_token, web_identity_token: "sts.jwt.token")
    end
  end

  def hello
    Translation::Request.new(source_text: "Hello", source_language: Translation::Language::EN,
      target_language: Translation::Language::ES, context: nil)
  end

  def translate(client)
    Translation::ClaudeTranslator.new(client:).translate(hello)
  end

  def stub_exchange(*responses)
    stub_request(:post, "https://api.anthropic.com/v1/oauth/token").to_return(*responses)
  end

  def token_response(token)
    { status: 200, headers: { "Content-Type" => "application/json" }, body: { access_token: token, expires_in: 3600 }.to_json }
  end

  def stub_messages(token, status:, body:)
    stub_request(:post, %r{\Ahttps://api\.anthropic\.com/v1/messages})
      .with(headers: { "Authorization" => "Bearer #{token}" })
      .to_return(status:, headers: { "Content-Type" => "application/json" }, body:)
  end

  def auth_error_body
    { type: "error", error: { type: "authentication_error", message: "token revoked" } }.to_json
  end

  def message_body
    {
      id: "m", type: "message", role: "assistant", model: "claude-opus-5",
      content: [ { type: "text", text: { translation: "Hola", notes: "" }.to_json } ],
      stop_reason: "end_turn", stop_sequence: nil, stop_details: nil, container: nil,
      usage: { input_tokens: 1, output_tokens: 1 }
    }.to_json
  end
end
