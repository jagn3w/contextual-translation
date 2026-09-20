import * as Select from "@radix-ui/react-select";
import type { Language } from "../gql/graphql.ts";
import { LANGUAGES, languageName } from "../lib/languages.ts";

type Props = {
  label: string;
  value: Language;
  onChange: (language: Language) => void;
};

/** A quiet, keyboard-accessible language picker (Radix Select, design D1.4). */
export function LanguageSelect({ label, value, onChange }: Props) {
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(next as Language)}>
      {/* min-w-0 + truncate: the language bar is one row even on a ~360px phone, so the name gives
          way rather than pushing the row wider than the screen. The chevron never shrinks.
          `asChild` is load-bearing: Radix's Select.Value destructures `className` away and never
          applies it, so the class has to land on a span we own. `truncate`'s overflow:hidden is
          also what drops this flex item's automatic minimum size to 0, letting it actually
          shrink inside the trigger instead of forcing the row wider. */}
      <Select.Trigger
        aria-label={label}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-ink hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <Select.Value asChild>
          <span className="truncate">{languageName(value)}</span>
        </Select.Value>
        <Select.Icon className="shrink-0 text-muted" aria-hidden>
          ▾
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-40 overflow-hidden rounded-lg border border-line bg-canvas p-1 shadow-lg"
        >
          <Select.Viewport>
            {LANGUAGES.map((language) => (
              <Select.Item
                key={language.code}
                value={language.code}
                className="flex cursor-default select-none items-center justify-between gap-4 rounded-md px-2 py-1.5 text-sm text-ink outline-none data-[highlighted]:bg-surface data-[state=checked]:font-medium"
              >
                <Select.ItemText>{language.name}</Select.ItemText>
                <span className="text-xs text-muted">{language.nativeName}</span>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
