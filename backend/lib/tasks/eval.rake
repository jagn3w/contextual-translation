# frozen_string_literal: true

namespace :eval do
  desc "Run eval/cases.yml against Claude. EFFORTS=low,medium (default) ONLY=case-id,... " \
       "Needs TRANSLATOR=claude credentials (CLAUDE_AUTH=api_key + ANTHROPIC_API_KEY locally). Costs money."
  task translations: :environment do
    cases = TranslationEval::EvalCase.load_file(Rails.root.join("eval/cases.yml"))
    only = ENV["ONLY"].to_s.split(",").map(&:strip).reject(&:empty?)
    cases = cases.select { |eval_case| only.include?(eval_case.id) } if only.any?
    efforts = ENV.fetch("EFFORTS", "low,medium").split(",").map(&:strip)

    efforts.each do |effort|
      translator = Translation.build_translator(ENV.to_h.merge("TRANSLATOR" => "claude", "CLAUDE_EFFORT" => effort))
      TranslationEval::Runner.new(translator:, cases:).run(label: "effort=#{effort}")
      puts
    end
  end
end
