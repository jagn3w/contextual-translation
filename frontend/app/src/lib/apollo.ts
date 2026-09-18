import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from "@apollo/client";
import { ErrorLink } from "@apollo/client/link/error";
import { isUnauthenticated } from "./requestFailure.ts";

type Options = {
  /** Called whenever the server says the session is missing, expired or revoked. */
  onUnauthenticated: () => void;
};

/**
 * The app's Apollo Client. Requests go to /graphql on the same origin — in development Vite
 * proxies it to Rails — so the session cookie travels automatically (design D1.6, D4.2).
 */
export function createApolloClient({ onUnauthenticated }: Options): ApolloClient {
  const errorLink = new ErrorLink(({ error }) => {
    if (isUnauthenticated(error)) onUnauthenticated();
  });
  const httpLink = new HttpLink({ uri: "/graphql", credentials: "same-origin" });

  return new ApolloClient({
    link: ApolloLink.from([errorLink, httpLink]),
    cache: new InMemoryCache(),
  });
}
