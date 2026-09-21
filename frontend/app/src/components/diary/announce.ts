import { createContext, useContext } from "react";

/**
 * Says something to screen readers through the diary's one live region (DiaryView). One region,
 * always mounted, because a status element that mounts already holding its text is one many screen
 * readers never read out. Outside a DiaryView — a component rendered on its own — it does nothing.
 */
export const AnnounceContext = createContext<(message: string) => void>(() => undefined);

export function useAnnounce(): (message: string) => void {
  return useContext(AnnounceContext);
}
