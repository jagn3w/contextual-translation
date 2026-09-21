/**
 * Diary drafts the server may not have yet, by entry id: typed and not saved, or saved and not yet
 * confirmed. They outlive the entry's workspace, which unmounts whenever the learner switches entry
 * or page: a learner who comes back before the unmount save has landed would otherwise be handed
 * the older body from the cache, and their next keystroke would save over the newer text.
 */
const drafts = new Map<string, string>();

export function unsavedDraft(entryId: string): string | undefined {
  return drafts.get(entryId);
}

export function rememberDraft(entryId: string, text: string): void {
  drafts.set(entryId, text);
}

/** Forgets the draft once the server has `text` — unless the learner has typed on since. */
export function draftSaved(entryId: string, text: string): void {
  if (drafts.get(entryId) === text) drafts.delete(entryId);
}

/** Via wipeSessionState whenever a session ends or begins, and between tests. */
export function forgetDrafts(): void {
  drafts.clear();
}
