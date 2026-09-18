# frozen_string_literal: true

require "test_helper"

# The committed schema.graphql is the client's codegen contract (design D1.2); it must match the
# Ruby schema. Fix a failure with `bin/rails graphql:dump_schema`.
class GraphqlSchemaDumpTest < ActiveSupport::TestCase
  test "schema.graphql is up to date" do
    committed = Rails.root.join("schema.graphql").read

    assert_equal ContextualTranslateSchema.to_definition, committed,
      "schema.graphql is stale; run bin/rails graphql:dump_schema"
  end
end
