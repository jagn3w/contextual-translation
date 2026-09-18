import type { CodegenConfig } from "@graphql-codegen/cli";

// Generates typed documents from the committed backend schema — the server/client type contract
// (design D1.2). bin/check fails if the committed output in src/gql is stale.
const config: CodegenConfig = {
  schema: "../../backend/schema.graphql",
  documents: ["src/**/*.graphql"],
  ignoreNoDocuments: false,
  generates: {
    "src/gql/": {
      preset: "client",
      presetConfig: { fragmentMasking: false },
      config: {
        useTypeImports: true,
        // TypeScript enums aren't erasable syntax (tsconfig erasableSyntaxOnly); use unions.
        enumsAsTypes: true,
        strictScalars: true,
        scalars: { ISO8601DateTime: "string" },
      },
    },
  },
};

export default config;
