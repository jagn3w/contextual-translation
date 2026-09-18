import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from "@apollo/client";
import { ErrorLink } from "@apollo/client/link/error";
import { isUnauthenticated } from "./requestFailure.ts";

type Options = {
  /**
   * Called when an operation fails because the session is missing, expired or revoked. The
   * Viewer query is excluded: its 401 is how the app learns it's signed out in the first place.
   */
  onUnauthenticated: () => void;
};

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
    link: ApolloLink.from([errorLink, httpLink]),
    cache: new InMemoryCache(),
  });
}
