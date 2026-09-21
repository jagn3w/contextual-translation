import type { ApolloClient } from "@apollo/client";
import { forgetDrafts } from "./unsavedDrafts.ts";

/**
 * Forgets everything the client holds for the session that just ended: the diary drafts not yet
 * saved and the whole Apollo cache (entries, bodies, threads, translations). All of it is tab
 * memory — nothing is persisted — so this is the whole of it. The one way to wipe, so no path can
 * do half: App calls it on sign-out, when a session ends, and again on sign-in.
 *
 * `clearStore` cancels the queries still in flight, so call it with no query mounted that could
 * turn the cancellation into an error on screen.
 */
export async function wipeSessionState(client: ApolloClient): Promise<void> {
  forgetDrafts();
  await client.clearStore();
}
