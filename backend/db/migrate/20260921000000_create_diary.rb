# frozen_string_literal: true

# The diary (docs/diary.md): entries private to an access code, the tutor's threads on them, and
# the comments in each thread. Deleting a code or an entry takes everything under it with it.
#
# Each table has a random `public_id`, the only id the API exposes or accepts: the bigint primary
# keys are shared sequences across every access code, so exposing them would reveal how many
# entries, threads and comments exist app-wide. They stay internal (ordering, foreign keys).
class CreateDiary < ActiveRecord::Migration[8.1]
  def change
    create_table :diary_entries do |t|
      t.uuid :public_id, null: false, default: -> { "gen_random_uuid()" }
      # Nothing here is unique by date: a learner may write as many entries a day as they like.
      t.references :access_code, null: false, foreign_key: { on_delete: :cascade }, index: false
      # Translation::Language serializations ("en", "es", "ja").
      t.string :language, null: false
      t.string :notes_language, null: false
      t.text :body, null: false, default: ""
      # The body as it was last reviewed: thread spans are offsets into this, not into `body`.
      t.text :reviewed_body
      t.datetime :reviewed_at
      # How many reviews the entry has had; threads record the round that created them.
      t.integer :review_count, null: false, default: 0

      t.timestamps
    end
    # The scrollback lists one code's entries, newest first.
    add_index :diary_entries, [ :access_code_id, :created_at ]
    add_index :diary_entries, :public_id, unique: true
    add_check_constraint :diary_entries, "language IN ('en', 'es', 'ja')", name: "diary_entries_language"
    add_check_constraint :diary_entries, "notes_language IN ('en', 'es', 'ja')", name: "diary_entries_notes_language"

    create_table :diary_threads do |t|
      t.uuid :public_id, null: false, default: -> { "gen_random_uuid()" }
      t.references :diary_entry, null: false, foreign_key: { on_delete: :cascade }
      t.string :kind, null: false
      t.string :verdict
      t.text :sentence
      t.integer :starts_at
      t.integer :length
      t.string :title
      t.boolean :current, null: false, default: true
      t.integer :hint_level, null: false, default: 0
      t.datetime :resolved_at
      # The entry's review_count when a SENTENCE or ENTRY thread was created; null for HELP.
      t.integer :review_round

      t.timestamps
    end
    add_index :diary_threads, :public_id, unique: true
    add_check_constraint :diary_threads, "kind IN ('sentence', 'entry', 'help')", name: "diary_threads_kind"
    add_check_constraint :diary_threads, "verdict IS NULL OR verdict IN ('correct', 'improvable', 'wrong')",
      name: "diary_threads_verdict"

    create_table :diary_comments do |t|
      t.uuid :public_id, null: false, default: -> { "gen_random_uuid()" }
      t.references :diary_thread, null: false, foreign_key: { on_delete: :cascade }
      t.string :author, null: false
      t.text :body, null: false

      t.timestamps
    end
    add_index :diary_comments, :public_id, unique: true
    add_check_constraint :diary_comments, "author IN ('learner', 'tutor')", name: "diary_comments_author"
  end
end
