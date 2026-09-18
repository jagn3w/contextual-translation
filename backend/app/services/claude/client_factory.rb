# typed: strict
# frozen_string_literal: true

module Claude
  # Builds the Anthropic client for the configured auth mode (design D5.2):
  #   CLAUDE_AUTH=wif     — production: Workload Identity Federation. The EC2 instance role asks
  #                         AWS STS for a short-lived identity token; Anthropic exchanges it for an
  #                         access token. No Anthropic secret is stored anywhere.
  #   CLAUDE_AUTH=api_key — local development and the eval set: ANTHROPIC_API_KEY (a dev key).
  module ClientFactory
    extend T::Sig

    class ConfigurationError < StandardError; end

    AUDIENCE = "https://api.anthropic.com"
    IDENTITY_TOKEN_TTL_SECONDS = 900
    # The SDK's own retries are off; ClaudeTranslator retries once, and never on timeouts (D2.2).
    TIMEOUT_SECONDS = 30.0
    # With explicit WIF credentials the SDK ignores these today, but any default-constructed
    # client (a console session, a future code path) would pick them up and bypass WIF — and their
    # presence in production means the environment is misconfigured. Refuse to boot.
    CONFLICTING_ENV = T.let(%w[ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_PROFILE].freeze, T::Array[String])

    sig { params(env: T::Hash[String, String], sts: T.nilable(Aws::STS::Client)).returns(Anthropic::Client) }
    def self.build(env = ENV.to_h, sts: nil)
      case (mode = env.fetch("CLAUDE_AUTH", "api_key"))
      when "wif" then build_wif(env, sts:)
      when "api_key" then build_api_key(env)
      else raise ConfigurationError, "CLAUDE_AUTH must be wif or api_key (got #{mode.inspect})"
      end
    end

    sig { params(env: T::Hash[String, String]).returns(Anthropic::Client) }
    def self.build_api_key(env)
      api_key = env["ANTHROPIC_API_KEY"].presence
      raise ConfigurationError, "CLAUDE_AUTH=api_key requires ANTHROPIC_API_KEY" if api_key.nil?

      Anthropic::Client.new(api_key:, max_retries: 0, timeout: TIMEOUT_SECONDS)
    end

    sig { params(env: T::Hash[String, String], sts: T.nilable(Aws::STS::Client)).returns(Anthropic::Client) }
    def self.build_wif(env, sts: nil)
      conflicting = CONFLICTING_ENV.select { |name| env[name].present? }
      if conflicting.any?
        raise ConfigurationError,
          "CLAUDE_AUTH=wif but #{conflicting.join(', ')} is set; it would silently override " \
          "Workload Identity Federation. Unset it."
      end

      region = required(env, "AWS_REGION")
      federation = {
        federation_rule_id: required(env, "ANTHROPIC_FEDERATION_RULE_ID"),
        organization_id: required(env, "ANTHROPIC_ORGANIZATION_ID"),
        service_account_id: required(env, "ANTHROPIC_SERVICE_ACCOUNT_ID"),
        workspace_id: env["ANTHROPIC_WORKSPACE_ID"].presence
      }
      # Created on first use: constructing an STS client resolves AWS credentials (instance
      # metadata), which shouldn't happen — or stall — at boot. Tight timeouts and one retry
      # bound a slow STS; normally only the background refresher waits on it.
      sts_client = T.let(sts, T.nilable(Aws::STS::Client))
      workload_identity = Anthropic::Credentials::WorkloadIdentity.new(
        identity_token_provider: -> { identity_token(sts_client ||= bounded_sts_client(region)) },
        **federation
      )
      credentials = TokenRefresher.new(provider: workload_identity)
      # T.unsafe: the gem's bundled RBI predates the `credentials:` keyword (it exists at runtime).
      T.unsafe(Anthropic::Client).new(credentials:, max_retries: 0, timeout: TIMEOUT_SECONDS)
    end

    sig { params(region: String).returns(Aws::STS::Client) }
    def self.bounded_sts_client(region)
      Aws::STS::Client.new(region:, http_open_timeout: 2, http_read_timeout: 5, retry_limit: 1)
    end

    # A fresh STS token for each exchange; TokenRefresher caches the resulting access token.
    sig { params(sts: Aws::STS::Client).returns(String) }
    def self.identity_token(sts)
      sts.get_web_identity_token(
        audience: [ AUDIENCE ],
        signing_algorithm: "RS256",
        duration_seconds: IDENTITY_TOKEN_TTL_SECONDS
      ).web_identity_token
    end

    sig { params(env: T::Hash[String, String], name: String).returns(String) }
    def self.required(env, name)
      env[name].presence || raise(ConfigurationError, "CLAUDE_AUTH=wif requires #{name}")
    end
  end
end
