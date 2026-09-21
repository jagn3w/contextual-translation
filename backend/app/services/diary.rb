# typed: strict
# frozen_string_literal: true

# The diary (docs/diary.md). `Diary.tutor` is the configured Tutor, chosen by the same
# TRANSLATOR setting as `Translation.translator`: fake (default; tests, CI, frontend work) or
# claude.
module Diary
  extend T::Sig

  sig { returns(Tutor) }
  def self.tutor
    @tutor ||= T.let(build_tutor(client: -> { Claude.client }), T.nilable(Tutor))
  end

  sig { params(tutor: T.nilable(Tutor)).void }
  def self.tutor=(tutor)
    @tutor = tutor
  end

  # The same production guard as Translation.build_translator: a fake tutor must never serve
  # placeholder feedback in production. `client` is only called for TRANSLATOR=claude; the app's
  # tutor gets the shared Claude.client, the one ClaudeTranslator uses.
  sig do
    params(env: T::Hash[String, String], production: T::Boolean, client: T.proc.returns(Anthropic::Client))
      .returns(Tutor)
  end
  def self.build_tutor(env = ENV.to_h, production: Rails.env.production?,
                       client: -> { Claude::ClientFactory.build(env, sts: nil) })
    if production && env["TRANSLATOR"] != "claude"
      raise ArgumentError, "TRANSLATOR must be claude in production (got #{env['TRANSLATOR'].inspect})"
    end

    case (kind = env.fetch("TRANSLATOR", "fake"))
    when "fake"
      FakeTutor.new
    when "claude"
      ClaudeTutor.new(
        client: client.call,
        model: env.fetch("CLAUDE_MODEL", Translation::ClaudeTranslator::DEFAULT_MODEL),
        effort: env.fetch("CLAUDE_EFFORT", Translation::ClaudeTranslator::DEFAULT_EFFORT)
      )
    else
      raise ArgumentError, "TRANSLATOR must be fake or claude (got #{kind.inspect})"
    end
  end
end
