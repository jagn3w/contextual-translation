import type { ReactNode } from "react";
import { handleLinkClick, type Route, routePath } from "../lib/router.ts";

type Props = {
  route: Route;
  onSignOut: () => void;
  children: ReactNode;
};

const PAGES = [
  { page: "phrases", label: "Phrases", href: routePath({ page: "phrases" }) },
  { page: "diary", label: "Diary", href: routePath({ page: "diary", entryId: null }) },
] as const;

/**
 * The frame every signed-in page shares: the title, the two menu options and Sign out. Each page
 * brings its own `<main>`.
 *
 * The menu options are real links, so opening one in a new tab, copying it or middle-clicking it
 * all work; a plain click is taken over by handleLinkClick and navigates in place. The current page
 * is marked with `aria-current="page"`, which is also what the styling keys on, so what a screen
 * reader is told and what a sighted reader sees can't disagree.
 */
export function AppShell({ route, onSignOut, children }: Props) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
        <h1 className="text-base font-semibold tracking-tight">Contextual Translate</h1>
        <nav aria-label="Main" className="flex items-center gap-1">
          {PAGES.map((item) => (
            <a
              key={item.page}
              href={item.href}
              onClick={handleLinkClick}
              aria-current={route.page === item.page ? "page" : undefined}
              // The current page is marked by weight and an underline, not by colour alone.
              className="focus-ring rounded-md px-2 py-1 text-sm text-muted hover:bg-surface hover:text-ink aria-[current=page]:font-medium aria-[current=page]:text-ink aria-[current=page]:underline aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-8"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <button
          type="button"
          onClick={onSignOut}
          className="ml-auto rounded-md px-2 py-1 text-sm text-muted hover:bg-surface hover:text-ink"
        >
          Sign out
        </button>
      </header>
      {children}
    </div>
  );
}
