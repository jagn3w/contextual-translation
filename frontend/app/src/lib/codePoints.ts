/** Length in Unicode code points — how the backend (Ruby String#length) counts the limits. */
export function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}
