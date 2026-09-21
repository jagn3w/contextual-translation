# typed: strict
# frozen_string_literal: true

# A shared secret that grants access to the app (design D4.1). Codes carry 120 random bits,
# shown once at creation; only an HMAC digest is stored, so a database leak exposes no usable
# code.
class AccessCode < ApplicationRecord
  # Crockford base32: no I, L, O or U, so codes are unambiguous to read and type.
  ALPHABET = T.let("0123456789ABCDEFGHJKMNPQRSTVWXYZ", String)
  BODY_LENGTH = 24 # 24 characters x 5 bits = 120 bits
  GROUP_SIZE = 4
  PREFIX = "ctx"
  # Crockford's decoding rules for look-alike characters.
  LOOKALIKES = T.let({ "O" => "0", "I" => "1", "L" => "1" }.freeze, T::Hash[String, String])

  has_many :diary_entries, dependent: :delete_all

  validates :label, presence: true, length: { maximum: 100 }
  validates :code_digest, presence: true, uniqueness: true

  scope :active, -> { where(revoked_at: nil).where("expires_at IS NULL OR expires_at > ?", Time.current) }

  class << self
    extend T::Sig

    # Creates a code and returns it with its plaintext, which is never retrievable again.
    sig { params(label: String, expires_at: T.nilable(ActiveSupport::TimeWithZone)).returns([ AccessCode, String ]) }
    def generate!(label:, expires_at: nil)
      body = Array.new(BODY_LENGTH) { ALPHABET[SecureRandom.random_number(ALPHABET.length)] }.join
      plaintext = [ PREFIX, *body.scan(/.{#{GROUP_SIZE}}/o) ].join("-")
      record = create!(label:, expires_at:, code_digest: digest(body))
      [ record, plaintext ]
    end

    # Returns the active code matching `input`, or nil. Records the use.
    sig { params(input: String).returns(T.nilable(AccessCode)) }
    def authenticate(input)
      body = normalize(input)
      return nil if body.nil?

      record = active.find_by(code_digest: digest(body))
      record&.touch(:last_used_at)
      record
    end

    # Canonical code body: case, whitespace, dashes and the optional "ctx" prefix are ignored,
    # and look-alike characters are decoded. Returns nil when the input can't be a code.
    sig { params(input: String).returns(T.nilable(String)) }
    def normalize(input)
      compact = input.upcase.gsub(/[\s-]/, "")
      compact = compact.delete_prefix(PREFIX.upcase) if compact.length == BODY_LENGTH + PREFIX.length
      body = compact.gsub(/[OIL]/) { |char| LOOKALIKES.fetch(char) }
      return nil unless body.length == BODY_LENGTH && body.each_char.all? { |char| ALPHABET.include?(char) }

      body
    end

    sig { params(body: String).returns(String) }
    def digest(body)
      OpenSSL::HMAC.hexdigest("SHA256", Rails.application.config.x.access_code_pepper, body)
    end
  end

  sig { returns(T::Boolean) }
  def active?
    return false if revoked_at.present?

    expiry = expires_at
    expiry.nil? || expiry.future?
  end

  sig { void }
  def revoke!
    update!(revoked_at: Time.current) if revoked_at.nil?
  end
end
