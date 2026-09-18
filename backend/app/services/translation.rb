# typed: strict
# frozen_string_literal: true

# Context-aware translation (design D2). `Translation.translator` is the configured Translator:
# TRANSLATOR=fake (default; tests, CI, frontend work) or TRANSLATOR=claude.
module Translation
  extend T::Sig

  sig { returns(Translator) }
  def self.translator
    @translator ||= T.let(build_translator, T.nilable(Translator))
  end

  sig { params(translator: T.nilable(Translator)).void }
  def self.translator=(translator)
    @translator = translator
  end

  # In production TRANSLATOR must be set explicitly to claude: a missing or `fake` value would
  # otherwise boot and serve placeholder translations while every check reported success.
  sig { params(env: T::Hash[String, String], production: T::Boolean).returns(Translator) }
  def self.build_translator(env = ENV.to_h, production: Rails.env.production?)
    if production && env["TRANSLATOR"] != "claude"
      raise ArgumentError, "TRANSLATOR must be claude in production (got #{env['TRANSLATOR'].inspect})"
    end

    case (kind = env.fetch("TRANSLATOR", "fake"))
    when "fake"
      FakeTranslator.new
    when "claude"
      ClaudeTranslator.new(
        client: Claude::ClientFactory.build(env, sts: nil),
        model: env.fetch("CLAUDE_MODEL", ClaudeTranslator::DEFAULT_MODEL),
        effort: env.fetch("CLAUDE_EFFORT", ClaudeTranslator::DEFAULT_EFFORT)
      )
    else
      raise ArgumentError, "TRANSLATOR must be fake or claude (got #{kind.inspect})"
    end
  end
end
