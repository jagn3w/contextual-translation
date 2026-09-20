/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
/** How much of a translation to gloss with per-word definitions (design D2.3). */
export type GlossLevel =
  /** Every content word and set phrase, skipping function words. */
  | 'EVERY'
  /** No glosses at all. */
  | 'NONE'
  /** Only the words worth remarking on: ambiguous, idiomatic or register-carrying ones. */
  | 'NOTABLE';

/** A supported language. */
export type Language =
  /** English */
  | 'EN'
  /** Spanish */
  | 'ES'
  /** Japanese */
  | 'JA';

/** Why a translation failed. Each code has its own user-facing message (design D3.3). */
export type TranslateErrorCode =
  /** The demo's Claude usage budget is used up. */
  | 'BUDGET_EXCEEDED'
  /** The source text is blank. */
  | 'EMPTY_INPUT'
  /** The source text or context is over its length limit. */
  | 'INPUT_TOO_LONG'
  /** The translation was too long to finish. */
  | 'OUTPUT_TOO_LONG'
  /** This session or access code is translating too quickly. */
  | 'RATE_LIMITED'
  /** Claude declined to translate the text. */
  | 'REFUSED'
  /** The source and target languages are the same. */
  | 'SAME_LANGUAGE'
  /** The server's Claude credentials or settings are wrong. */
  | 'SERVICE_MISCONFIGURED'
  /** Claude took too long to respond. */
  | 'TIMEOUT'
  /** Claude returned a server error. */
  | 'UPSTREAM_ERROR'
  /** Claude is temporarily overloaded. */
  | 'UPSTREAM_OVERLOADED'
  /** Claude is rate-limiting requests. */
  | 'UPSTREAM_RATE_LIMITED'
  /** Claude could not be reached. */
  | 'UPSTREAM_UNREACHABLE';

export type TranslateInput = {
  /** The situation: where you are, who is speaking to whom, the desired formality or region. */
  context?: string | null | undefined;
  /** How much of the translation to gloss with per-word definitions. */
  glossLevel?: GlossLevel | null | undefined;
  sourceLanguage: Language;
  sourceText: string;
  targetLanguage: Language;
};

export type TranslateMutationVariables = Exact<{
  input: TranslateInput;
}>;


export type TranslateMutation = { translate: { translation: { text: string, notes: string | null, furigana: string | null, glossesTruncated: boolean, sourceLanguage: Language, targetLanguage: Language, glosses: Array<{ text: string, reading: string | null, meaning: string, startsAt: number, length: number }> } | null, errors: Array<{ code: TranslateErrorCode, message: string, retryable: boolean, retryAfterSeconds: number | null }> } };

export type ViewerQueryVariables = Exact<{ [key: string]: never; }>;


export type ViewerQuery = { viewer: { accessCodeLabel: string, accessCodeExpiresAt: string | null, sessionExpiresAt: string } };


export const TranslateDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"Translate"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"TranslateInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"translate"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"translation"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"notes"}},{"kind":"Field","name":{"kind":"Name","value":"furigana"}},{"kind":"Field","name":{"kind":"Name","value":"glosses"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"text"}},{"kind":"Field","name":{"kind":"Name","value":"reading"}},{"kind":"Field","name":{"kind":"Name","value":"meaning"}},{"kind":"Field","name":{"kind":"Name","value":"startsAt"}},{"kind":"Field","name":{"kind":"Name","value":"length"}}]}},{"kind":"Field","name":{"kind":"Name","value":"glossesTruncated"}},{"kind":"Field","name":{"kind":"Name","value":"sourceLanguage"}},{"kind":"Field","name":{"kind":"Name","value":"targetLanguage"}}]}},{"kind":"Field","name":{"kind":"Name","value":"errors"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"code"}},{"kind":"Field","name":{"kind":"Name","value":"message"}},{"kind":"Field","name":{"kind":"Name","value":"retryable"}},{"kind":"Field","name":{"kind":"Name","value":"retryAfterSeconds"}}]}}]}}]}}]} as unknown as DocumentNode<TranslateMutation, TranslateMutationVariables>;
export const ViewerDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Viewer"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"viewer"},"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"accessCodeLabel"}},{"kind":"Field","name":{"kind":"Name","value":"accessCodeExpiresAt"}},{"kind":"Field","name":{"kind":"Name","value":"sessionExpiresAt"}}]}}]}}]} as unknown as DocumentNode<ViewerQuery, ViewerQueryVariables>;