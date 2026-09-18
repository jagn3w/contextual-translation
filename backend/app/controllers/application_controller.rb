# typed: strict
# frozen_string_literal: true

class ApplicationController < ActionController::API
  extend T::Sig
  include ActionController::Cookies
  include RequestOriginCheck
  include Authentication
end
