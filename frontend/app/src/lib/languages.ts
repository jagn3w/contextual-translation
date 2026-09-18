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
