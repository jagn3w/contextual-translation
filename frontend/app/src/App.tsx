import { ApolloProvider, useApolloClient, useQuery } from "@apollo/client/react";
import { useCallback, useRef, useState } from "react";
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
import { forgetDrafts } from "./lib/unsavedDrafts.ts";
import { flushAutosaves } from "./lib/useAutosave.ts";
import { DiaryPage } from "./pages/DiaryPage.tsx";
import { TranslatePage } from "./pages/TranslatePage.tsx";

type Props = {
  createClient?: typeof createApolloClient;
};

/**
 * Owns the Apollo client and the session lifecycle. Bumping `epoch` remounts SessionBoundary,
 * which re-asks the server who we are — after sign-in, sign-out, or a session ending mid-use.
 */
export function App({ createClient = createApolloClient }: Props) {
  const [epoch, setEpoch] = useState(0);
  const [sessionEnded, setSessionEnded] = useState(false);
  // Set by a deliberate sign-out until the next sign-in. A request still out when the session was
  // deleted comes back unauthenticated, and that is no news to someone who just signed out: it must
  // not replace the gate with "Your session ended".
  const signedOut = useRef(false);
  const [client] = useState(() =>
    createClient({
      onUnauthenticated: () => {
        if (signedOut.current) return;
        setSessionEnded(true);
        setEpoch((value) => value + 1);
      },
    }),
  );
  const restart = useCallback((reason: "signedIn" | "signedOut") => {
    signedOut.current = reason === "signedOut";
    setSessionEnded(false);
    setEpoch((value) => value + 1);
  }, []);

  return (
    <ApolloProvider client={client}>
      <SessionBoundary key={epoch} sessionEnded={sessionEnded} onRestart={restart} />
      <Toaster position="bottom-center" closeButton toastOptions={{ duration: 8000 }} />
    </ApolloProvider>
  );
}

type BoundaryProps = {
  sessionEnded: boolean;
  onRestart: (reason: "signedIn" | "signedOut") => void;
};

/** Restores the session on load via the Viewer query (design D4.2) and routes to the gate or the app. */
function SessionBoundary({ sessionEnded, onRestart }: BoundaryProps) {
  const client = useApolloClient();
  const { data, error, loading, refetch } = useQuery(ViewerDocument, { fetchPolicy: "network-only" });

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
    forgetDrafts();
    await client.clearStore();
    onRestart("signedOut");
  }, [client, onRestart]);

  if (error) {
    const failure = describeRequestError(error);
    if (failure.kind === "unauthenticated") {
      return (
        <AccessGate
          notice={sessionEnded ? failureMessage(failure) : undefined}
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
