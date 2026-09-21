import { CombinedGraphQLErrors } from "@apollo/client";
import { skipToken, useApolloClient, useQuery } from "@apollo/client/react";
import { useMemo } from "react";
import { toast } from "sonner";
import { type DiaryActions, DiaryView } from "../components/diary/DiaryView.tsx";
import {
  CreateDiaryEntryDocument,
  DeleteDiaryEntryDocument,
  DiaryEntriesDocument,
  DiaryEntryDocument,
  type DiaryErrorFieldsFragment,
  type Language,
  ReplyToDiaryThreadDocument,
  RequestDiaryHintDocument,
  ResolveDiaryThreadDocument,
  ReviewDiaryEntryDocument,
  SaveDiaryEntryDocument,
  StartDiaryHelpThreadDocument,
  SuggestDiaryTopicsDocument,
} from "../gql/graphql.ts";
import { failureMessage } from "../lib/failureMessage.ts";
import { describeRequestError } from "../lib/requestFailure.ts";
import { navigate, routePath } from "../lib/router.ts";
import { translateErrorMessage } from "../lib/translateErrorMessage.ts";

type Props = {
  /** The entry the URL names (`/diary/<id>`), or null for `/diary`. */
  entryId: string | null;
};

/** The pair a first entry gets: English notes on Japanese writing, the Phrases showcase pair. */
const FIRST_PAIR: { language: Language; notesLanguage: Language } = { language: "JA", notesLanguage: "EN" };

/** The top-level GraphQL error codes the diary mutations raise on purpose (docs/diary.md). */
function graphQLCode(caught: unknown): string | null {
  if (!CombinedGraphQLErrors.is(caught)) return null;
  const code = caught.errors.map((error) => error.extensions?.["code"]).find((value) => typeof value === "string");
  return typeof code === "string" ? code : null;
}

type Toast = { id?: string };

/**
 * The toast for a request that failed outright. The wording is the app's own (failureMessage),
 * except for the two refusals only the diary can meet, which failureMessage would call "something
 * unexpected" when they are nothing of the kind.
 */
function reportFailure(caught: unknown, options: Toast = {}) {
  const code = graphQLCode(caught);
  if (code === "NOT_FOUND") {
    toast.error("This entry doesn't exist any more.", options);
    return;
  }
  if (code === "INVALID") {
    toast.error("The languages can't change once an entry has had feedback.", options);
    return;
  }
  const failure = describeRequestError(caught);
  // An ended session is handled by the app, which returns to the access-code screen.
  if (failure.kind === "unauthenticated") return;
  toast.error(failureMessage(failure), options);
}

/**
 * The toast for an anticipated failure — the same codes and words as a translation's, except the
 * three input checks, whose translation wording ("Enter some text to translate.") would misdescribe
 * a diary entry or a question.
 */
function reportError(error: DiaryErrorFieldsFragment) {
  toast.error(diaryErrorMessage(error));
}

export function diaryErrorMessage(error: DiaryErrorFieldsFragment): string {
  switch (error.code) {
    case "EMPTY_INPUT":
      return "Write something first.";
    case "INPUT_TOO_LONG":
      return "That's over the length limit (10,000 characters for an entry, 2,000 for a question or reply). Shorten it and try again.";
    case "SAME_LANGUAGE":
      return "The language you write in and your notes language must be different.";
    default:
      return translateErrorMessage(error.code, error.retryAfterSeconds ?? null, error.message);
  }
}

/**
 * The diary (docs/diary.md): the queries and mutations behind DiaryView.
 *
 * Every mutation asks for the fields its query does, so Apollo's normalised cache carries a result
 * into both the scrollback and the open entry by id — a save updates the list's preview, a review
 * replaces the entry's threads, a reply or a hint updates its thread in place. Only the changes to
 * *which* things exist are written by hand: a new entry into the list, a new help thread into its
 * entry, a deleted entry out of both.
 *
 * A failed tutor call saves nothing on the server, so every action reports its failure here and
 * resolves false or null, and the component that asked keeps the learner's words in place.
 */
export function DiaryPage({ entryId }: Props) {
  const client = useApolloClient();
  const list = useQuery(DiaryEntriesDocument);
  const selected = useQuery(DiaryEntryDocument, entryId === null ? skipToken : { variables: { id: entryId } });
  const entries = list.data?.diaryEntries ?? null;
  const entry = entryId === null ? null : (selected.data?.diaryEntry ?? null);
  const loadError = list.error ?? selected.error;

  const actions = useMemo((): DiaryActions => {
    /** Runs a mutation, turning a thrown failure into its toast and an undefined result. */
    async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
      try {
        return await run();
      } catch (caught) {
        reportFailure(caught);
        return undefined;
      }
    }

    /** The shared tail of the four thread mutations: report a typed error, say whether it worked. */
    function settled(payload: { thread: unknown; errors: DiaryErrorFieldsFragment[] } | undefined): boolean {
      if (payload === undefined) return false;
      const error = payload.errors[0];
      if (error !== undefined) {
        reportError(error);
        return false;
      }
      return payload.thread !== null;
    }

    function currentEntries() {
      return client.readQuery({ query: DiaryEntriesDocument })?.diaryEntries ?? [];
    }

    return {
      async onNewEntry() {
        // The newest entry's pair, since a learner mostly keeps writing in the language they were.
        const latest = currentEntries()[0];
        const pair = latest === undefined ? FIRST_PAIR : { language: latest.language, notesLanguage: latest.notesLanguage };
        const result = await attempt(() =>
          client.mutate({
            mutation: CreateDiaryEntryDocument,
            variables: { input: pair },
            update(cache, { data }) {
              const created = data?.createDiaryEntry.entry;
              if (created == null) return;
              cache.updateQuery({ query: DiaryEntriesDocument }, (current) =>
                current === null ? current : { diaryEntries: [created, ...current.diaryEntries] },
              );
              // So opening it is a cache hit rather than a second round trip for what we hold.
              cache.writeQuery({ query: DiaryEntryDocument, variables: { id: created.id }, data: { diaryEntry: created } });
            },
          }),
        );
        const payload = result?.data?.createDiaryEntry;
        const error = payload?.errors[0];
        if (error !== undefined) reportError(error);
        if (payload?.entry != null) navigate(routePath({ page: "diary", entryId: payload.entry.id }));
      },

      async onSaveBody(id, body) {
        try {
          const result = await client.mutate({ mutation: SaveDiaryEntryDocument, variables: { input: { id, body } } });
          // A typed refusal (over the length limit) is already on screen beside the counter, and
          // the indicator says "Not saved"; a toast at every pause in typing would only repeat it.
          return result.data?.updateDiaryEntry.entry != null;
        } catch (caught) {
          // A save landing after its entry was deleted has nothing left to tell anyone. Otherwise
          // one toast id for every save, so a flaky connection shows one message, not a stack.
          if (graphQLCode(caught) !== "NOT_FOUND") reportFailure(caught, { id: "diary-save" });
          return false;
        }
      },

      async onRequestFeedback(id, body) {
        const result = await attempt(() =>
          client.mutate({ mutation: ReviewDiaryEntryDocument, variables: { input: { id, body } } }),
        );
        const payload = result?.data?.reviewDiaryEntry;
        const error = payload?.errors[0];
        if (error !== undefined) {
          reportError(error);
          return false;
        }
        return payload?.entry != null;
      },

      async onChangeLanguages(id, language, notesLanguage) {
        const result = await attempt(() =>
          client.mutate({ mutation: SaveDiaryEntryDocument, variables: { input: { id, language, notesLanguage } } }),
        );
        const error = result?.data?.updateDiaryEntry.errors[0];
        if (error !== undefined) reportError(error);
      },

      async onDeleteEntry(id) {
        const result = await attempt(() =>
          client.mutate({
            mutation: DeleteDiaryEntryDocument,
            variables: { input: { id } },
            update(cache, { data }) {
              if (data?.deleteDiaryEntry.deletedId == null) return;
              cache.updateQuery({ query: DiaryEntriesDocument }, (current) =>
                current === null ? current : { diaryEntries: current.diaryEntries.filter((item) => item.id !== id) },
              );
              // Its URL now answers "doesn't exist" from the cache — the back button lands there —
              // rather than showing the deleted entry, or asking the server what it just said.
              cache.writeQuery({ query: DiaryEntryDocument, variables: { id }, data: { diaryEntry: null } });
              const ref = cache.identify({ __typename: "DiaryEntry", id });
              if (ref !== undefined) cache.evict({ id: ref });
              cache.gc();
            },
          }),
        );
        if (result?.data?.deleteDiaryEntry.deletedId == null) return false;
        navigate(routePath({ page: "diary", entryId: null }));
        return true;
      },

      async onSuggestTopics(id, body) {
        const source = client.readQuery({ query: DiaryEntryDocument, variables: { id } })?.diaryEntry;
        if (source == null) return null;
        const result = await attempt(() =>
          client.mutate({
            mutation: SuggestDiaryTopicsDocument,
            variables: {
              input: {
                language: source.language,
                notesLanguage: source.notesLanguage,
                body: body.trim() === "" ? null : body,
              },
            },
          }),
        );
        const payload = result?.data?.suggestDiaryTopics;
        if (payload === undefined) return null;
        const error = payload.errors[0];
        if (error !== undefined) {
          reportError(error);
          return null;
        }
        return payload.topics;
      },

      async onStartHelp(id, question) {
        const result = await attempt(() =>
          client.mutate({
            mutation: StartDiaryHelpThreadDocument,
            variables: { input: { entryId: id, question } },
            update(cache, { data }) {
              const thread = data?.startDiaryHelpThread.thread;
              if (thread == null) return;
              cache.updateQuery({ query: DiaryEntryDocument, variables: { id } }, (current) =>
                current?.diaryEntry == null
                  ? current
                  : { diaryEntry: { ...current.diaryEntry, threads: [...current.diaryEntry.threads, thread] } },
              );
            },
          }),
        );
        return settled(result?.data?.startDiaryHelpThread);
      },

      async onReply(threadId, body) {
        const result = await attempt(() =>
          client.mutate({ mutation: ReplyToDiaryThreadDocument, variables: { input: { threadId, body } } }),
        );
        return settled(result?.data?.replyToDiaryThread);
      },

      async onRequestHint(threadId) {
        const result = await attempt(() =>
          client.mutate({ mutation: RequestDiaryHintDocument, variables: { input: { threadId } } }),
        );
        return settled(result?.data?.requestDiaryHint);
      },

      async onResolve(threadId, resolved) {
        const result = await attempt(() =>
          client.mutate({ mutation: ResolveDiaryThreadDocument, variables: { input: { threadId, resolved } } }),
        );
        return settled(result?.data?.resolveDiaryThread);
      },
    };
  }, [client]);

  const loadFailure = loadError === undefined ? null : describeRequestError(loadError);
  return (
    <DiaryView
      entries={entries}
      selectedId={entryId}
      entry={entry}
      entryLoading={entryId !== null && selected.loading}
      loadError={loadFailure === null || loadFailure.kind === "unauthenticated" ? null : failureMessage(loadFailure)}
      onRetry={() => {
        if (list.error) void list.refetch().catch(() => undefined);
        if (selected.error) void selected.refetch().catch(() => undefined);
      }}
      actions={actions}
    />
  );
}
