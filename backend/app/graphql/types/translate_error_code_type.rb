# typed: strict
# frozen_string_literal: true

module Types
  class TranslateErrorCodeType < Types::BaseEnum
    graphql_name "TranslateErrorCode"
    description "Why a translation failed. Each code has its own user-facing message (design D3.3)."

    DESCRIPTIONS = T.let(
      {
        "EMPTY_INPUT" => "The source text is blank.",
        "INPUT_TOO_LONG" => "The source text or context is over its length limit.",
        "SAME_LANGUAGE" => "The source and target languages are the same.",
        "RATE_LIMITED" => "This session or access code is translating too quickly.",
        "TIMEOUT" => "Claude took too long to respond.",
        "UPSTREAM_RATE_LIMITED" => "Claude is rate-limiting requests.",
        "UPSTREAM_OVERLOADED" => "Claude is temporarily overloaded.",
        "UPSTREAM_ERROR" => "Claude returned a server error.",
        "UPSTREAM_UNREACHABLE" => "Claude could not be reached.",
        "BUDGET_EXCEEDED" => "The demo's Claude usage budget is used up.",
        "SERVICE_MISCONFIGURED" => "The server's Claude credentials or settings are wrong.",
        "REFUSED" => "Claude declined to translate the text.",
        "OUTPUT_TOO_LONG" => "The translation was too long to finish."
      }.freeze,
      T::Hash[String, String]
    )

    Translation::ErrorCode.values.each do |code|
      value code.serialize, DESCRIPTIONS.fetch(code.serialize), value: code
    end
  end
end
