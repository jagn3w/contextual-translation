import { type MouseEvent, useSyncExternalStore } from "react";

/**
 * The app's two pages and the one parameter between them (docs/diary.md). Rails serves the SPA for
 * every HTML path, so the paths are real URLs — reloadable, bookmarkable, back-button-able — and a
 * two-page app gets that from `history` without a routing dependency.
 */
export type Route = { page: "phrases" } | { page: "diary"; entryId: string | null };

/** Which page a path names. Anything unrecognised is Phrases, the landing page, rather than a 404. */
export function parseRoute(pathname: string): Route {
  const diary = /^\/diary(?:\/([^/]+))?\/?$/.exec(pathname);
  if (diary !== null) {
    const id = diary[1];
    return { page: "diary", entryId: id === undefined ? null : decodeURIComponent(id) };
  }
  return { page: "phrases" };
}

export function routePath(route: Route): string {
  if (route.page === "phrases") return "/";
  return route.entryId === null ? "/diary" : `/diary/${encodeURIComponent(route.entryId)}`;
}

// `pushState` fires no event of its own, so navigate() announces itself on this one; `popstate`
// covers the back and forward buttons.
const NAVIGATED = "app:navigated";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATED, onChange);
  };
}

/** The current path, re-rendering on every navigation — ours, or the browser's back and forward. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useRoute(): Route {
  return parseRoute(usePathname());
}

/**
 * Goes to `path` without a page load. `replace` rewrites the current history entry instead of
 * adding one — for a redirect the user didn't ask for, which the back button shouldn't land on.
 */
export function navigate(path: string, { replace = false }: { replace?: boolean } = {}): void {
  if (path === window.location.pathname) return;
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAVIGATED));
}

/**
 * A click handler for an `<a href>` that navigates in place — but only for a plain left click. A
 * modified click (new tab, new window, download) and a middle click are the browser's, and so is a
 * link some other handler already dealt with; the href is a real URL, so the browser does the
 * right thing with all of them.
 */
export function handleLinkClick(event: MouseEvent<HTMLAnchorElement>): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.currentTarget.getAttribute("target");
  if (target !== null && target !== "_self") return;
  event.preventDefault();
  navigate(event.currentTarget.pathname);
}
