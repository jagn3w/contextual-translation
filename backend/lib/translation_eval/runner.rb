# typed: strict
# frozen_string_literal: true

module TranslationEval
  # Runs the eval cases through a translator and summarizes quality and latency (design D2.2:
  # target p95 under 10 s).
  class Runner
    extend T::Sig

    # The cases in this category exist to measure the costliest reply the prompt allows — a
    # source at the furigana limit, readings on, every word glossed — so their latency is a
    # separate measurement, not a sample of what a reader waits for. Left in the percentiles they
    # swamped them: at 19 cases the 95th percentile is the 19th value, so the one case built to
    # be the slowest *was* the p95, and design D2.2's target read as blown on every run whether
    # or not anything had regressed. Each one is timed on its own line instead.
    LATENCY_EXCLUDED_CATEGORY = "length"

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
        if furigana then "furigana #{furigana.length} chars"
        # readings_omitted covers every way a Japanese reply can arrive without them — source over
        # the limit, no kanji to annotate, or an annotation Result rejected — so the cause is in
        # the Rails log for this run (ClaudeTranslator#log_furigana_loss), not in this line.
        elsif result.readings_omitted then "furigana omitted"
        else "no furigana"
        end
      "#{readings}, glosses #{result.glosses.size}#{result.glosses_truncated ? ' (capped)' : ''}"
    end

    sig { params(outcomes: T::Array[Outcome]).void }
    def summarize(outcomes)
      timed, untimed = outcomes.partition { |outcome| outcome.eval_case.category != LATENCY_EXCLUDED_CATEGORY }
      seconds = timed.map(&:seconds)
      passed = outcomes.count { |outcome| outcome.failures.empty? }
      # Pass counts are over every case; the latencies are over the timed ones only, and say so,
      # so nobody reads a p95 taken over 18 cases as one taken over 19.
      @io.puts format(
        "-- passed %d/%d  p50 %.1fs  p95 %.1fs  max %.1fs  (latency over %d cases; %s timed separately)",
        passed, outcomes.size, self.class.percentile(seconds, 0.5), self.class.percentile(seconds, 0.95),
        seconds.max || 0.0, timed.size, LATENCY_EXCLUDED_CATEGORY
      )
      untimed.each do |outcome|
        @io.puts format("   %-10s %-22s %.1fs  (the worst reply the prompt allows; not in the percentiles)",
          outcome.eval_case.category, outcome.eval_case.id, outcome.seconds)
      end
      outcomes.group_by { |outcome| outcome.eval_case.category }.each do |category, group|
        @io.puts format("   %-10s %d/%d", category, group.count { |outcome| outcome.failures.empty? }, group.size)
      end
    end
  end
end
