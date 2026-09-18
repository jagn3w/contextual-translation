# frozen_string_literal: true

namespace :claude do
  desc "Check that the app can authenticate to Claude and get a translation (run after each deploy)"
  task auth_check: :environment do
    auth = ENV.fetch("CLAUDE_AUTH", "api_key")
    puts "TRANSLATOR=#{ENV.fetch('TRANSLATOR', 'fake')} CLAUDE_AUTH=#{auth}"

    if auth == "wif"
      print "1/3 AWS STS identity token... "
      sts = Aws::STS::Client.new(region: ENV.fetch("AWS_REGION"))
      token = Claude::ClientFactory.identity_token(sts)
      puts "ok (#{token.bytesize} bytes)"
    end

    print "#{auth == 'wif' ? '2/3' : '1/2'} Build translator... "
    translator = Translation.build_translator
    puts "ok (#{translator.class.name})"

    print "#{auth == 'wif' ? '3/3' : '2/2'} Translate \"Is this a bat?\" at a baseball game... "
    result = translator.translate(
      Translation::Request.new(
        source_text: "Is this a bat?",
        source_language: Translation::Language::EN,
        target_language: Translation::Language::ES,
        context: "At a baseball game, pointing at the equipment rack."
      )
    )
    puts "ok"
    puts "  #{result.text}  (model: #{result.model})"
    puts "  notes: #{result.notes}" if result.notes
  rescue StandardError => e
    puts "FAILED"
    abort "#{e.class}: #{e.message}"
  end
end
