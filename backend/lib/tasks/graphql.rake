# frozen_string_literal: true

namespace :graphql do
  desc "Dump the GraphQL schema to schema.graphql (the client codegen contract, design D1.2)"
  task dump_schema: :environment do
    path = Rails.root.join("schema.graphql")
    File.write(path, ContextualTranslateSchema.to_definition)
    puts "Wrote #{path}"
  end
end
