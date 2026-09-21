# typed: strict
# frozen_string_literal: true

module Types
  class TranslateErrorCodeType < Types::BaseEnum
    graphql_name "TranslateErrorCode"
    # The same codes serve the Phrases and Diary features, so the descriptions name neither.
    description "Why an operation failed, for translations and diary tutor calls alike. Each code has its " \
                "own user-facing message."

    DESCRIPTIONS = T.let(
      {
        "EMPTY_INPUT" => "The text is blank.",
        "INPUT_TOO_LONG" => "A text is over its length limit.",
        "SAME_LANGUAGE" => "The two languages are the same.",
        "RATE_LIMITED" => "This session or access code is over its limit of Claude requests.",
        "TIMEOUT" => "Claude took too long to respond.",
        "UPSTREAM_RATE_LIMITED" => "Claude is rate-limiting requests.",
        "UPSTREAM_OVERLOADED" => "Claude is temporarily overloaded.",
        "UPSTREAM_ERROR" => "Claude returned a server error.",
        "UPSTREAM_UNREACHABLE" => "Claude could not be reached.",
        "BUDGET_EXCEEDED" => "The demo's Claude usage budget is used up.",
        "SERVICE_MISCONFIGURED" => "The server's Claude credentials or settings are wrong.",
        "REFUSED" => "Claude declined the request.",
        "OUTPUT_TOO_LONG" => "Claude's answer was too long to finish."
      }.freeze,
      T::Hash[String, String]
    )

    Translation::ErrorCode.values.each do |code|
      value code.serialize, DESCRIPTIONS.fetch(code.serialize), value: code
    end
  end
end
