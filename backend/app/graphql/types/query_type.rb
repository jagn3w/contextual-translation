# typed: strict
# frozen_string_literal: true

module Types
  class QueryType < Types::BaseObject
    field :viewer, Types::ViewerType, null: false, description: "The signed-in session."

    field :diary_entries, [ Types::DiaryEntryType ], null: false,
      description: "This access code's diary entries, newest first."
    field :diary_entry, Types::DiaryEntryType, description: "Null when missing or not this access code's." do
      T.bind(self, Types::BaseField)
      argument :id, ID
    end

    sig { returns(Authentication::Current) }
    def viewer
      current_session
    end

    sig { returns(T::Array[DiaryEntry]) }
    def diary_entries
      current_session.access_code.diary_entries.order(created_at: :desc, id: :desc).to_a
    end

    sig { params(id: String).returns(T.nilable(DiaryEntry)) }
    def diary_entry(id:)
      current_session.access_code.diary_entries.find_by(id:)
    end

    private

    sig { returns(Authentication::Current) }
    def current_session
      context.fetch(:current_session)
    end
  end
end
