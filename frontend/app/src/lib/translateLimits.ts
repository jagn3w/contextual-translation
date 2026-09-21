/**
 * The translate mutation's length limits, the same the backend enforces, counted in code points
 * (see codePoints.ts). Shared by the Phrases page's counters and the INPUT_TOO_LONG message.
 */
export const MAX_SOURCE_LENGTH = 10_000;
export const MAX_CONTEXT_LENGTH = 2_000;
