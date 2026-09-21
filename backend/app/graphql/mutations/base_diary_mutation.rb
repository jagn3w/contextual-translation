# typed: strict
# frozen_string_literal: true

module Mutations
  # Shared by the diary mutations (docs/diary.md): every record is found through the session's
  # access code, so another code's id is indistinguishable from a missing one.
  class BaseDiaryMutation < Mutations::BaseMutation
    private

    sig { returns(Authentication::Current) }
    def session
      context.fetch(:current_session)
    end

    # `id` is the public id (PublicId); a malformed one is NOT_FOUND like a missing one.
    sig { params(id: T.untyped).returns(DiaryEntry) }
    def find_entry!(id)
      public_id = PublicId.parse(id) || not_found!("diary entry")
      session.access_code.diary_entries.find_by(public_id:) || not_found!("diary entry")
    end

    sig { params(id: T.untyped).returns(DiaryThread) }
    def find_thread!(id)
      public_id = PublicId.parse(id) || not_found!("diary thread")
      DiaryThread.joins(:diary_entry).where(diary_entries: { access_code_id: session.access_code.id })
        .find_by(public_id:) || not_found!("diary thread")
    end

    sig { params(what: String).returns(T.noreturn) }
    def not_found!(what)
      raise GraphQL::ExecutionError.new("No such #{what}.", extensions: { "code" => "NOT_FOUND" })
    end

    # A change the entry's state refuses (Diary::Service::Invalid): its languages after feedback,
    # or a tutor answer for a language pair the entry no longer has.
    sig { params(message: String).returns(T.noreturn) }
    def invalid!(message)
      raise GraphQL::ExecutionError.new(message, extensions: { "code" => "INVALID" })
    end

    sig { returns(Diary::Service) }
    def service
      Diary::Service.new
    end
  end
end
