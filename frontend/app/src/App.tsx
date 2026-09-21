import { ApolloProvider, useApolloClient, useQuery } from "@apollo/client/react";
import { useCallback, useState } from "react";
import { Toaster, toast } from "sonner";
import { AccessGate } from "./components/AccessGate.tsx";
import { StatusScreen } from "./components/StatusScreen.tsx";
import { ViewerDocument } from "./gql/graphql.ts";
import { createApolloClient } from "./lib/apollo.ts";
import { failureMessage } from "./lib/failureMessage.ts";
import { describeRequestError } from "./lib/requestFailure.ts";
import { signOut } from "./lib/session.ts";
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
  const [client] = useState(() =>
    createClient({
      onUnauthenticated: () => {
        setSessionEnded(true);
        setEpoch((value) => value + 1);
      },
    }),
  );
  const restart = useCallback((ended: boolean) => {
    setSessionEnded(ended);
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
  onRestart: (sessionEnded: boolean) => void;
};

/** Restores the session on load via the Viewer query (design D4.2) and routes to the gate or the app. */
function SessionBoundary({ sessionEnded, onRestart }: BoundaryProps) {
  const client = useApolloClient();
  const { data, error, loading, refetch } = useQuery(ViewerDocument, { fetchPolicy: "network-only" });

  const handleSignOut = useCallback(async () => {
    const result = await signOut();
    if (!result.ok) {
      // The session cookie is still valid; staying put is the honest outcome.
      toast.error(`Couldn't sign out. ${failureMessage(result.reason)}`);
      return;
    }
    await client.clearStore();
    onRestart(false);
  }, [client, onRestart]);

  if (error) {
    const failure = describeRequestError(error);
    if (failure.kind === "unauthenticated") {
      return (
        <AccessGate
          notice={sessionEnded ? failureMessage(failure) : undefined}
          onSignedIn={() => onRestart(false)}
        />
      );
    }
    // A failed retry re-renders this screen via `error`; swallow the rejected promise itself.
    return <StatusScreen message={failureMessage(failure)} onRetry={() => void refetch().catch(() => undefined)} />;
  }
  if (loading || data === undefined) return <StatusScreen message="Loading…" />;

  // The page shows nothing from the viewer itself; the query is still what restores the
  // session (design D4.2), and reaching here at all is what says there is one.
  return <TranslatePage onSignOut={() => void handleSignOut()} />;
}
