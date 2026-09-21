# typed: strict
# frozen_string_literal: true

# Everything the app shares for talking to Claude. `Claude.client` is the one Anthropic client per
# process: ClaudeTranslator and Diary::ClaudeTutor both use it, so with Workload Identity
# Federation there is one TokenRefresher (one warmer thread, one token) however many features call
# Claude (design D5.2, docs/diary.md).
module Claude
  extend T::Sig

  @lock = T.let(Mutex.new, Mutex)
  @client = T.let(nil, T.nilable(Anthropic::Client))

  sig { returns(Anthropic::Client) }
  def self.client
    @lock.synchronize { @client ||= ClientFactory.build(ENV.to_h, sts: nil) }
  end
end
