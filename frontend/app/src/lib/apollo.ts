import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from "@apollo/client";
import { ErrorLink } from "@apollo/client/link/error";
import { Observable } from "rxjs";
import { isUnauthenticated } from "./requestFailure.ts";
import { currentSession } from "./sessionState.ts";

type Options = {
  /**
   * Called when an operation fails because the session is missing, expired or revoked. The
   * Viewer query is excluded: its 401 is how the app learns it's signed out in the first place.
   * App answers it by wiping this client's cache and the unsaved drafts, then showing the gate.
   */
  onUnauthenticated: () => void;
};

/**
 * Drops the result of an operation that comes back after the session it was sent in has ended
 * (currentSession moved on): nothing is written to the cache and nothing reaches the caller, whose
 * promise never settles. `clearStore` cancels only queries, so without this a mutation still out
 * — Get feedback, a hint, an autosave — could finish inside the next access code's session, write
 * the old code's entry into its cache and toast on its screen. The caller is gone by then (the
 * signed-in tree unmounts before any session change), so there is no one to tell.
 */
const sessionLink = new ApolloLink(
  (operation, forward) =>
    new Observable((observer) => {
      const session = currentSession();
      const live = () => currentSession() === session;
      const subscription = forward(operation).subscribe({
        next: (result) => {
          if (live()) observer.next(result);
        },
        error: (error: unknown) => {
          if (live()) observer.error(error);
        },
        complete: () => {
          if (live()) observer.complete();
        },
      });
      return () => subscription.unsubscribe();
    }),
);

/**
 * The app's Apollo Client. Requests go to /graphql on the same origin — in development Vite
 * proxies it to Rails — so the session cookie travels automatically (design D1.6, D4.2).
 */
export function createApolloClient({ onUnauthenticated }: Options): ApolloClient {
  const errorLink = new ErrorLink(({ error, operation }) => {
    if (operation.operationName !== "Viewer" && isUnauthenticated(error)) onUnauthenticated();
  });
  const httpLink = new HttpLink({ uri: "/graphql", credentials: "same-origin" });

  return new ApolloClient({
    link: ApolloLink.from([sessionLink, errorLink, httpLink]),
    cache: new InMemoryCache(),
  });
}
