# typed: strict
# frozen_string_literal: true

module TranslationEval
  # Runs the eval cases through a translator and summarizes quality and latency (design D2.2:
  # target p95 under 10 s).
  class Runner
    extend T::Sig

    class Outcome < T::Struct
      const :eval_case, EvalCase
      const :seconds, Float
      const :result, T.nilable(Translation::Result)
      const :failures, T::Array[String]
    end

    sig { params(translator: Translation::Translator, cases: T::Array[EvalCase], io: T.any(IO, StringIO)).void }
    def initialize(translator:, cases:, io: $stdout)
      @translator = translator
      @cases = cases
      @io = io
    end

    sig { params(label: String).returns(T::Array[Outcome]) }
    def run(label:)
      @io.puts "== #{label} (#{@cases.size} cases)"
      outcomes = @cases.map { |eval_case| run_case(eval_case) }
      summarize(outcomes)
      outcomes
    end

    sig { params(values: T::Array[Float], fraction: Float).returns(Float) }
    def self.percentile(values, fraction)
      sorted = values.sort
      return 0.0 if sorted.empty?

      T.must(sorted[((sorted.size - 1) * fraction).ceil])
    end

    private

    sig { params(eval_case: EvalCase).returns(Outcome) }
    def run_case(eval_case)
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC).to_f
      result = T.let(nil, T.nilable(Translation::Result))
      failures = begin
        result = @translator.translate(eval_case.request)
        eval_case.failures(result.text)
      rescue Translation::Error => e
        [ "error #{e.code.serialize}: #{e.message}" ]
      rescue StandardError => e
        # An unmapped failure (e.g. a 400 after a prompt change) fails this case, not the run.
        [ "unexpected #{e.class}: #{e.message.truncate(200)}" ]
      end
      seconds = Process.clock_gettime(Process::CLOCK_MONOTONIC).to_f - started
      report(eval_case, result, failures, seconds)
      Outcome.new(eval_case:, seconds:, result:, failures:)
    end

    sig do
      params(eval_case: EvalCase, result: T.nilable(Translation::Result), failures: T::Array[String], seconds: Float).void
    end
    def report(eval_case, result, failures, seconds)
      status = failures.empty? ? "PASS" : "FAIL"
      @io.puts format("%-4s %5.1fs  %-22s %s", status, seconds, eval_case.id, result&.text.to_s.tr("\n", " "))
      @io.puts "             notes: #{result.notes}" if result&.notes
      @io.puts "             #{annotations(result)}" if result
      failures.each { |failure| @io.puts "             ! #{failure}" }
    end

    # What the reply cost besides the translation, so a long case shows whether the readings and
    # the full gloss list survived the limits or were degraded away (Translation::Prompt).
    sig { params(result: Translation::Result).returns(String) }
    def annotations(result)
      furigana = result.furigana
      readings =
        if result.readings_omitted then "furigana omitted (source over the limit)"
        elsif furigana then "furigana #{furigana.length} chars"
        else "no furigana"
        end
      "#{readings}, glosses #{result.glosses.size}#{result.glosses_truncated ? ' (capped)' : ''}"
    end

    sig { params(outcomes: T::Array[Outcome]).void }
    def summarize(outcomes)
      seconds = outcomes.map(&:seconds)
      passed = outcomes.count { |outcome| outcome.failures.empty? }
      @io.puts format(
        "-- passed %d/%d  p50 %.1fs  p95 %.1fs  max %.1fs",
        passed, outcomes.size, self.class.percentile(seconds, 0.5), self.class.percentile(seconds, 0.95), seconds.max || 0.0
      )
      outcomes.group_by { |outcome| outcome.eval_case.category }.each do |category, group|
        @io.puts format("   %-10s %d/%d", category, group.count { |outcome| outcome.failures.empty? }, group.size)
      end
    end
  end
end
