ENV["RAILS_ENV"] ||= "test"
# Tests never talk to Claude, whatever a developer's .env says (dotenv loads .env in test too and
# never overrides variables that are already set).
ENV["TRANSLATOR"] = "fake"
ENV["CLAUDE_AUTH"] = "api_key"
require_relative "../config/environment"
# Loaded from .env after the lines above, so remove them explicitly.
ENV.delete("ANTHROPIC_API_KEY")
ENV.delete("ANTHROPIC_AUTH_TOKEN")
require "rails/test_help"

module ActiveSupport
  class TestCase
    # Run tests in parallel with specified workers
    parallelize(workers: :number_of_processors)

    # Setup all fixtures in test/fixtures/*.yml for all tests in alphabetical order.
    fixtures :all

    # Add more helper methods to be used by all tests here...
  end
end
