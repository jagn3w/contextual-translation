import { ApolloProvider, useQuery } from "@apollo/client/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { AccessGate } from "./components/AccessGate.tsx";
import { AppShell } from "./components/AppShell.tsx";
import { StatusScreen } from "./components/StatusScreen.tsx";
import { ViewerDocument } from "./gql/graphql.ts";
import { createApolloClient } from "./lib/apollo.ts";
import { failureMessage } from "./lib/failureMessage.ts";
import { describeRequestError } from "./lib/requestFailure.ts";
import { useRoute } from "./lib/router.ts";
import { signOut } from "./lib/session.ts";
import { retireSession, wipeSessionState } from "./lib/sessionState.ts";
import { flushAutosaves } from "./lib/useAutosave.ts";
import { DiaryPage } from "./pages/DiaryPage.tsx";
import { TranslatePage } from "./pages/TranslatePage.tsx";

type Props = {
  createClient?: typeof createApolloClient;
};

/** Why the session changed hands: each one wipes the client's copy of the old session first. */
type Restart = "signedIn" | "signedOut" | "sessionEnded";

/**
 * Owns the Apollo client and the session lifecycle. Bumping `epoch` remounts SessionBoundary,
 * which re-asks the server who we are — after sign-in, sign-out, or a session ending mid-use.
 *
 * Every restart retires the old session at once (operations still out lose their results; see
 * `retireSession`), then goes through `wiping`: the signed-in tree unmounts, `wipeSessionState`
 * forgets the unsaved drafts and clears the Apollo cache, and only then is the epoch bumped. So the next
 * session — possibly another access code's, on the same tab — never sees the last one's entries or
 * drafts, whether it ended by signing out, by expiring or being revoked, or by a sign-out in another
 * tab. Unmounting before the wipe matters: `clearStore` cancels in-flight queries, and a mounted
 * query would show the cancellation as an error. Nothing is persisted, so this is all there is.
 */
export function App({ createClient = createApolloClient }: Props) {
  const [epoch, setEpoch] = useState(0);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [wiping, setWiping] = useState<Restart | null>(null);
  // Set when there is no session, by a deliberate sign-out or a session ending, until the server
  // next confirms one (the Viewer query succeeding: a sign-in here, or a Retry after signing in
  // from another tab). A request still out when the session went comes back unauthenticated, and
  // that is no news: after a sign-out it must not replace the gate with "Your session ended", and
  // after an ended session it must not wipe and restart a second time.
  const sessionGone = useRef(false);
  const restart = useCallback((reason: Restart) => {
    sessionGone.current = reason !== "signedIn";
    retireSession();
    setWiping(reason);
  }, []);
  const sessionLive = useCallback(() => {
    sessionGone.current = false;
  }, []);
  const [client] = useState(() =>
    createClient({
      onUnauthenticated: () => {
        if (sessionGone.current) return;
        // Whatever was typed since the last autosave is lost with the session: there is no session
        // left to save it to.
        restart("sessionEnded");
      },
    }),
  );

  useEffect(() => {
    if (wiping === null) return;
    // Runs after the commit that unmounted the signed-in tree, so no query is left mounted.
    void wipeSessionState(client)
      .catch(() => undefined)
      .then(() => {
        setSessionEnded(wiping === "sessionEnded");
        setEpoch((value) => value + 1);
        setWiping(null);
      });
  }, [client, wiping]);

  return (
    <ApolloProvider client={client}>
      {wiping === null ? (
        <SessionBoundary key={epoch} sessionEnded={sessionEnded} onRestart={restart} onSessionLive={sessionLive} />
      ) : (
        <StatusScreen message="Loading…" />
      )}
      <Toaster position="bottom-center" closeButton toastOptions={{ duration: 8000 }} />
    </ApolloProvider>
  );
}

type BoundaryProps = {
  sessionEnded: boolean;
  onRestart: (reason: "signedIn" | "signedOut") => void;
  /** The server has just confirmed a session: later refusals mean it ended again. */
  onSessionLive: () => void;
};

/** Restores the session on load via the Viewer query (design D4.2) and routes to the gate or the app. */
function SessionBoundary({ sessionEnded, onRestart, onSessionLive }: BoundaryProps) {
  const { data, error, loading, refetch } = useQuery(ViewerDocument, { fetchPolicy: "network-only" });
  const signedIn = data !== undefined && error === undefined;

  useEffect(() => {
    if (signedIn) onSessionLive();
  }, [signedIn, onSessionLive]);

  const handleSignOut = useCallback(async () => {
    // Diary drafts still waiting on their autosave go first: sent after the session is deleted,
    // they would be refused and lost.
    await flushAutosaves();
    const result = await signOut();
    if (!result.ok) {
      // The session cookie is still valid; staying put is the honest outcome.
      toast.error(`Couldn't sign out. ${failureMessage(result.reason)}`);
      return;
    }
    // The restart wipes the drafts and the cache once this tree has unmounted.
    onRestart("signedOut");
  }, [onRestart]);

  if (error) {
    const failure = describeRequestError(error);
    if (failure.kind === "unauthenticated") {
      return (
        <AccessGate
          notice={sessionEnded ? failureMessage(failure) : undefined}
          // Wipes again on the way in, a backstop: nothing of an earlier session reaches this one.
          onSignedIn={() => onRestart("signedIn")}
        />
      );
    }
    // A failed retry re-renders this screen via `error`; swallow the rejected promise itself.
    return <StatusScreen message={failureMessage(failure)} onRetry={() => void refetch().catch(() => undefined)} />;
  }
  if (loading || data === undefined) return <StatusScreen message="Loading…" />;

  // The page shows nothing from the viewer itself; the query is still what restores the
  // session (design D4.2), and reaching here at all is what says there is one.
  return <SignedIn onSignOut={() => void handleSignOut()} />;
}

/**
 * The signed-in app: the shared header and whichever page the URL names. Only this component
 * subscribes to the location, so navigating re-renders the pages without re-asking the server who
 * we are.
 */
function SignedIn({ onSignOut }: { onSignOut: () => void }) {
  const route = useRoute();
  return (
    <AppShell route={route} onSignOut={onSignOut}>
      {/* Phrases stays mounted, only hidden, while the diary is open: a translation and its draft
          are in-memory state, and a trip to the diary and back shouldn't cost them. */}
      <div hidden={route.page !== "phrases"}>
        <TranslatePage />
      </div>
      {route.page === "diary" && <DiaryPage entryId={route.entryId} />}
    </AppShell>
  );
}
