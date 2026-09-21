import type { Language } from "../gql/graphql.ts";

export type LanguageOption = { code: Language; name: string; nativeName: string };

/** The supported languages, in picker order (design MVP: English, Spanish, Japanese). */
export const LANGUAGES: ReadonlyArray<LanguageOption> = [
  { code: "EN", name: "English", nativeName: "English" },
  { code: "ES", name: "Spanish", nativeName: "Español" },
  { code: "JA", name: "Japanese", nativeName: "日本語" },
];

export function languageName(code: Language): string {
  return LANGUAGES.find((language) => language.code === code)?.name ?? code;
}

/**
 * The BCP 47 tag for a `lang` attribute. Marking the learner's text with its language is what gets
 * Japanese set in a Japanese font (not a Chinese fallback) and read by a screen reader's Japanese
 * voice rather than spelled out by its English one.
 */
export function languageTag(code: Language): string {
  return code.toLowerCase();
}
