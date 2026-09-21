import type { ApolloClient } from "@apollo/client";
import { forgetDrafts } from "./unsavedDrafts.ts";
import { forgetPendingAutosaves } from "./useAutosave.ts";

// Which session the client is serving; retireSession moves it on.
let session = 0;

/**
 * The session the client is serving now. The Apollo client stamps each operation with it when the
 * operation starts, and drops the result of one that comes back after the session changed.
 */
export function currentSession(): number {
  return session;
}

/**
 * Ends the old session on the client at once, before anything is unmounted or cleared: operations
 * still out lose their results (a feedback request answered after a sign-out and sign-in would
 * otherwise land in the next session's cache, or toast on its screen), the unsaved drafts are
 * forgotten, and so are the autosaves still being waited on (there is no session left to save to).
 */
export function retireSession(): void {
  session += 1;
  forgetDrafts();
  forgetPendingAutosaves();
}

/**
 * Forgets everything the client holds for the session that just ended: retires it (above), then
 * clears the whole Apollo cache (entries, bodies, threads, translations). All of it is tab memory —
 * nothing is persisted — so this is the whole of it. The one way to wipe, so no path can do half:
 * App calls it on sign-out, when a session ends, and again on sign-in.
 *
 * `clearStore` cancels the queries still in flight, so call it with no query mounted that could
 * turn the cancellation into an error on screen.
 */
export async function wipeSessionState(client: ApolloClient): Promise<void> {
  retireSession();
  await client.clearStore();
}
