import * as Select from "@radix-ui/react-select";
import type { GlossLevel } from "../gql/graphql.ts";

type Props = {
  value: GlossLevel;
  onChange: (level: GlossLevel) => void;
};

/**
 * How much of the translation gets a definition (design D2.3), in the order a reader steps through
 * it — off, the default, everything.
 *
 * A `Record` over the enum rather than a hand-kept list: a fourth GlossLevel is then a compile
 * error here instead of an option nobody can pick, labelled with its raw code. That is the
 * exhaustiveness design D3.3 asks of TranslateErrorCode, and `T.absurd` gives the backend.
 */
const LEVEL_NAMES: Record<GlossLevel, string> = {
  NONE: "None",
  NOTABLE: "Notable",
  EVERY: "All",
};

/** The same names as the picker's options, in the order written above — which is picker order. */
const LEVELS = Object.entries(LEVEL_NAMES) as ReadonlyArray<[GlossLevel, string]>;

/**
 * The picker for which words in the translation carry a hoverable definition. It sits on the
 * source pane's footer row beside the character count, so it reads as a setting *for the request*
 * — like the context field — rather than a control over the result already on screen: changing it
 * marks the result out of date and takes effect on the next translation.
 *
 * Modelled on LanguageSelect, scaled down to the footer row's text-xs and kept muted, because it
 * is a preference the reader sets once and then forgets.
 */
export function GlossLevelSelect({ value, onChange }: Props) {
  return (
    <Select.Root value={value} onValueChange={(next) => onChange(next as GlossLevel)}>
      {/* min-w-0 + truncate: the count on the row's other end keeps its digits; this gives way.
          `asChild` for the same reason as LanguageSelect: Select.Value drops `className`, so the
          truncation has to be on a span of ours. */}
      <Select.Trigger
        aria-label="Definitions"
        title="Which words in the translation get a definition"
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:bg-surface hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <Select.Value asChild>
          <span className="truncate">Definitions: {LEVEL_NAMES[value]}</span>
        </Select.Value>
        <Select.Icon className="shrink-0" aria-hidden>
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
            {LEVELS.map(([level, name]) => (
              <Select.Item
                key={level}
                value={level}
                className="flex cursor-default select-none items-center rounded-md px-2 py-1.5 text-xs text-ink outline-none data-[highlighted]:bg-surface data-[state=checked]:font-medium"
              >
                <Select.ItemText>{name}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
