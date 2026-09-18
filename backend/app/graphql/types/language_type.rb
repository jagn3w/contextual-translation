# typed: strict
# frozen_string_literal: true

module Types
  class LanguageType < Types::BaseEnum
    graphql_name "Language"
    description "A supported language."

    value "EN", "English", value: Translation::Language::EN
    value "ES", "Spanish", value: Translation::Language::ES
    value "JA", "Japanese", value: Translation::Language::JA
  end
end
