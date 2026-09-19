# frozen_string_literal: true

require "test_helper"

class SpaControllerTest < ActionDispatch::IntegrationTest
  INDEX = SpaController::INDEX

  setup do
    @existed = INDEX.exist?
    unless @existed
      INDEX.dirname.mkpath
      INDEX.write("<!doctype html><title>Contextual Translate</title>")
    end
  end

  teardown do
    unless @existed
      INDEX.delete
      INDEX.dirname.rmdir if INDEX.dirname.empty?
    end
  end

  test "serves index.html at the root with a strict CSP and no caching" do
    get "/", headers: { "Accept" => "text/html" }

    assert_response :success
    assert_includes response.body, "<title>Contextual Translate</title>"
    assert_equal "no-cache", response.headers["Cache-Control"]
    csp = response.headers["Content-Security-Policy"]
    assert_includes csp, "script-src 'self'"
    assert_includes csp, "frame-ancestors 'none'"
    assert_not_includes csp, "script-src 'self' 'unsafe-inline'"
  end

  test "serves index.html for client-side routes without a session" do
    get "/some/client/route", headers: { "Accept" => "text/html" }

    assert_response :success
    assert_includes response.body, "Contextual Translate"
  end

  test "does not catch non-HTML requests" do
    get "/missing.js"

    assert_response :not_found
  end

  test "explains when the frontend isn't built" do
    INDEX.rename(INDEX.sub_ext(".bak"))
    get "/", headers: { "Accept" => "text/html" }

    assert_response :not_found
    assert_includes response.body, "pnpm dev"
  ensure
    INDEX.sub_ext(".bak").rename(INDEX) if INDEX.sub_ext(".bak").exist?
  end
end
