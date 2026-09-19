# typed: strict
# frozen_string_literal: true

class ApplicationController < ActionController::API
  extend T::Sig
  include ActionController::Cookies
  include RequestSizeLimit
  include RequestOriginCheck
  include Authentication
end
