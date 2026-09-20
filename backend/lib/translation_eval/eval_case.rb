# typed: strict
# frozen_string_literal: true

module TranslationEval
  # One eval case from eval/cases.yml and how to grade a translation against it.
  class EvalCase < T::Struct
    extend T::Sig

    const :id, String
    const :category, String
    const :request, Translation::Request
    const :expect_any, T::Array[Regexp]
    const :reject, T::Array[Regexp]

    sig { params(path: Pathname).returns(T::Array[EvalCase]) }
    def self.load_file(path)
      entries = YAML.safe_load_file(path)
      raise ArgumentError, "#{path} must contain a list of cases" unless entries.is_a?(Array)

      cases = entries.map { |entry| from_hash(entry) }
      duplicates = cases.map(&:id).tally.select { |_id, count| count > 1 }.keys
      raise ArgumentError, "duplicate eval case ids: #{duplicates.join(', ')}" if duplicates.any?

      cases
    end

    sig { params(entry: T::Hash[String, T.untyped]).returns(EvalCase) }
    def self.from_hash(entry)
      gloss_level = entry["gloss_level"]
      new(
        id: entry.fetch("id"),
        category: entry.fetch("category"),
        request: Translation::Request.new(
          source_text: entry.fetch("text"),
          source_language: Translation::Language.deserialize(entry.fetch("from")),
          target_language: Translation::Language.deserialize(entry.fetch("to")),
          context: entry["context"].presence,
          # Optional in the YAML, and NOTABLE — the Request default — when a case leaves it out:
          # a case names a level only when the level is what it exists to exercise, such as the
          # long one that measures what glossing every word of a long translation costs.
          gloss_level: gloss_level.nil? ? Translation::GlossLevel::NOTABLE : Translation::GlossLevel.deserialize(gloss_level)
        ),
        expect_any: Array(entry["expect_any"]).map { |pattern| Regexp.new(pattern, Regexp::IGNORECASE) },
        reject: Array(entry["reject"]).map { |pattern| Regexp.new(pattern, Regexp::IGNORECASE) }
      )
    end

    # Returns the reasons the translation fails this case; empty means it passes.
    sig { params(translation: String).returns(T::Array[String]) }
    def failures(translation)
      reasons = []
      if expect_any.any? && expect_any.none? { |pattern| pattern.match?(translation) }
        reasons << "expected one of #{expect_any.map(&:source).join(' | ')}"
      end
      reject.each do |pattern|
        reasons << "matched rejected #{pattern.source}" if pattern.match?(translation)
      end
      reasons
    end
  end
end
