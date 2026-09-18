# frozen_string_literal: true

class CreateAccessCodes < ActiveRecord::Migration[8.1]
  def change
    create_table :access_codes do |t|
      t.string :label, null: false
      # HMAC-SHA256(ACCESS_CODE_PEPPER, normalized code), hex. The code itself is never stored.
      t.string :code_digest, null: false, index: { unique: true }
      t.datetime :expires_at
      t.datetime :revoked_at
      t.datetime :last_used_at

      t.timestamps
    end
  end
end
