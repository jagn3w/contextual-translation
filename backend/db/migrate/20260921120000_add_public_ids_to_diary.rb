# frozen_string_literal: true

# Each diary table gets a random `public_id`, the only id the API exposes or accepts: the bigint
# primary keys come from sequences shared by every access code, so exposing them would reveal how
# many entries, threads and comments exist app-wide. They stay internal (ordering, foreign keys).
#
# A separate migration rather than an edit to CreateDiary, so a database that already ran that one
# gets the column too. gen_random_uuid() is volatile, so Postgres fills every existing row with its
# own value as the column is added.
class AddPublicIdsToDiary < ActiveRecord::Migration[8.1]
  TABLES = %i[diary_entries diary_threads diary_comments].freeze

  def change
    TABLES.each do |table|
      add_column table, :public_id, :uuid, null: false, default: -> { "gen_random_uuid()" }
      add_index table, :public_id, unique: true
    end
  end
end
