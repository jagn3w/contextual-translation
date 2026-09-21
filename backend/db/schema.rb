# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_09_21_000000) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  create_table "access_codes", force: :cascade do |t|
    t.string "code_digest", null: false
    t.datetime "created_at", null: false
    t.datetime "expires_at"
    t.string "label", null: false
    t.datetime "last_used_at"
    t.datetime "revoked_at"
    t.datetime "updated_at", null: false
    t.index ["code_digest"], name: "index_access_codes_on_code_digest", unique: true
  end

  create_table "diary_comments", force: :cascade do |t|
    t.string "author", null: false
    t.text "body", null: false
    t.datetime "created_at", null: false
    t.bigint "diary_thread_id", null: false
    t.uuid "public_id", default: -> { "gen_random_uuid()" }, null: false
    t.datetime "updated_at", null: false
    t.index ["diary_thread_id"], name: "index_diary_comments_on_diary_thread_id"
    t.index ["public_id"], name: "index_diary_comments_on_public_id", unique: true
    t.check_constraint "author::text = ANY (ARRAY['learner'::character varying, 'tutor'::character varying]::text[])", name: "diary_comments_author"
  end

  create_table "diary_entries", force: :cascade do |t|
    t.bigint "access_code_id", null: false
    t.text "body", default: "", null: false
    t.datetime "created_at", null: false
    t.string "language", null: false
    t.string "notes_language", null: false
    t.uuid "public_id", default: -> { "gen_random_uuid()" }, null: false
    t.integer "review_count", default: 0, null: false
    t.datetime "reviewed_at"
    t.text "reviewed_body"
    t.datetime "updated_at", null: false
    t.index ["access_code_id", "created_at"], name: "index_diary_entries_on_access_code_id_and_created_at"
    t.index ["public_id"], name: "index_diary_entries_on_public_id", unique: true
    t.check_constraint "language::text = ANY (ARRAY['en'::character varying, 'es'::character varying, 'ja'::character varying]::text[])", name: "diary_entries_language"
    t.check_constraint "notes_language::text = ANY (ARRAY['en'::character varying, 'es'::character varying, 'ja'::character varying]::text[])", name: "diary_entries_notes_language"
  end

  create_table "diary_threads", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.boolean "current", default: true, null: false
    t.bigint "diary_entry_id", null: false
    t.integer "hint_level", default: 0, null: false
    t.string "kind", null: false
    t.integer "length"
    t.uuid "public_id", default: -> { "gen_random_uuid()" }, null: false
    t.datetime "resolved_at"
    t.integer "review_round"
    t.text "sentence"
    t.integer "starts_at"
    t.string "title"
    t.datetime "updated_at", null: false
    t.string "verdict"
    t.index ["diary_entry_id"], name: "index_diary_threads_on_diary_entry_id"
    t.index ["public_id"], name: "index_diary_threads_on_public_id", unique: true
    t.check_constraint "kind::text = ANY (ARRAY['sentence'::character varying, 'entry'::character varying, 'help'::character varying]::text[])", name: "diary_threads_kind"
    t.check_constraint "verdict IS NULL OR (verdict::text = ANY (ARRAY['correct'::character varying, 'improvable'::character varying, 'wrong'::character varying]::text[]))", name: "diary_threads_verdict"
  end

  create_table "solid_cache_entries", force: :cascade do |t|
    t.integer "byte_size", null: false
    t.datetime "created_at", null: false
    t.binary "key", null: false
    t.bigint "key_hash", null: false
    t.binary "value", null: false
    t.index ["byte_size"], name: "index_solid_cache_entries_on_byte_size"
    t.index ["key_hash", "byte_size"], name: "index_solid_cache_entries_on_key_hash_and_byte_size"
    t.index ["key_hash"], name: "index_solid_cache_entries_on_key_hash", unique: true
  end

  add_foreign_key "diary_comments", "diary_threads", on_delete: :cascade
  add_foreign_key "diary_entries", "access_codes", on_delete: :cascade
  add_foreign_key "diary_threads", "diary_entries", on_delete: :cascade
end
