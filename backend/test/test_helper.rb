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
require "webmock/minitest" # no test reaches the network; Claude calls are stubbed
Dir[File.expand_path("support/**/*.rb", __dir__)].each { |file| require file }

module ActiveSupport
  class TestCase
    # Serial on purpose: the suite takes seconds, several tests stub process-global state
    # (travel_to, WebMock, ENV), and parallel workers coordinate over a DRb Unix socket that the
    # dev-container sandbox blocks.
    parallelize(workers: 1)

    # Setup all fixtures in test/fixtures/*.yml for all tests in alphabetical order.
    fixtures :all

    # Add more helper methods to be used by all tests here...
  end
end

module ActionDispatch
  class IntegrationTest
    include SessionHelpers
  end
end
