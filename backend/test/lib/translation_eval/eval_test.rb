# frozen_string_literal: true

require "test_helper"

class TranslationEvalTest < ActiveSupport::TestCase
  CASES_PATH = Rails.root.join("eval/cases.yml")

  test "the eval set loads, has unique ids and covers every category and language" do
    cases = TranslationEval::EvalCase.load_file(CASES_PATH)

    assert_operator cases.size, :>=, 15
    assert_equal %w[ambiguity formality length region safety], cases.map(&:category).uniq.sort
    languages = cases.flat_map { |c| [ c.request.source_language, c.request.target_language ] }.uniq
    assert_equal Translation::Language.values.sort_by(&:serialize), languages.sort_by(&:serialize)
    cases.each do |eval_case|
      assert_not_equal eval_case.request.source_language, eval_case.request.target_language, eval_case.id
    end
  end

  test "a case can choose a gloss level, and leaves it at the Request default when it doesn't" do
    cases = TranslationEval::EvalCase.load_file(CASES_PATH).index_by(&:id)

    assert_equal Translation::GlossLevel::EVERY, cases.fetch("notice-long-ja").request.gloss_level
    assert_equal Translation::GlossLevel::NOTABLE, cases.fetch("bat-baseball-es").request.gloss_level
  end

  test "a long Japanese case exists, so the cost the furigana limit guesses at can be measured" do
    # The limit's comment points at this run. Without a case whose source is long enough to be
    # worth timing, and whose target is the language furigana costs anything in, it pointed at a
    # measurement the runner could not take.
    long = TranslationEval::EvalCase.load_file(CASES_PATH)
      .select { |eval_case| eval_case.request.target_language == Translation::Language::JA }
      .max_by { |eval_case| eval_case.request.source_text.length }

    assert_operator T.must(long).request.source_text.length, :>, Translation::Prompt::FURIGANA_LIMIT * 0.9
    assert_operator T.must(long).request.source_text.length, :<=, Translation::Prompt::FURIGANA_LIMIT,
      "the worst annotated reply is the one at the limit, so the case has to still ask for readings"
    assert_equal Translation::GlossLevel::EVERY, T.must(long).request.gloss_level
  end

  test "grading requires one expected pattern and no rejected ones" do
    bat = TranslationEval::EvalCase.load_file(CASES_PATH).find { |c| c.id == "bat-baseball-es" }

    assert_empty bat.failures("¿Esto es un bate?")
    assert_includes bat.failures("¿Esto es un murciélago?").join, "rejected"
    assert_includes bat.failures("¿Qué es esto?").join, "expected one of"
  end

  test "the runner reports pass counts and latency percentiles" do
    cases = TranslationEval::EvalCase.load_file(CASES_PATH).first(3)
    io = StringIO.new

    outcomes = TranslationEval::Runner.new(translator: Translation::FakeTranslator.new, cases:, io:).run(label: "fake")

    assert_equal 3, outcomes.size
    assert_match(%r{-- passed \d/3  p50 \d+\.\ds  p95 \d+\.\ds}, io.string)
  end

  test "an unexpected error fails its case instead of aborting the run" do
    cases = TranslationEval::EvalCase.load_file(CASES_PATH).first(2)
    broken = Class.new do
      include Translation::Translator
      define_method(:translate) { |_request| raise ArgumentError, "400 from a bad prompt" }
    end
    io = StringIO.new

    outcomes = TranslationEval::Runner.new(translator: broken.new, cases:, io:).run(label: "broken")

    assert_equal 2, outcomes.size
    assert_includes outcomes.first.failures.first, "unexpected ArgumentError"
    assert_match(%r{-- passed 0/2}, io.string)
  end

  test "percentile picks the nearest rank" do
    values = [ 1.0, 2.0, 3.0, 4.0, 10.0 ]

    assert_equal 3.0, TranslationEval::Runner.percentile(values, 0.5)
    assert_equal 10.0, TranslationEval::Runner.percentile(values, 0.95)
    assert_equal 0.0, TranslationEval::Runner.percentile([], 0.5)
  end
end
