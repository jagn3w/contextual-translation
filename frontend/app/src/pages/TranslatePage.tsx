import type { ViewerQuery } from "../gql/graphql.ts";

type Props = {
  viewer: ViewerQuery["viewer"];
  onSignOut: () => void;
};

/** The signed-in app. The translation workspace arrives with the translate-page task. */
export function TranslatePage({ viewer, onSignOut }: Props) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <h1 className="text-base font-semibold tracking-tight">Contextual Translate</h1>
        <div className="flex items-center gap-3 text-sm text-muted">
          <span>{viewer.accessCodeLabel}</span>
          <button type="button" onClick={onSignOut} className="rounded-md px-2 py-1 hover:bg-surface hover:text-ink">
            Sign out
          </button>
        </div>
      </header>
    </div>
  );
}
