/** "in 45 seconds", "in 10 minutes", "in 2 hours" — for retry-after messages. */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `in ${Math.max(1, Math.ceil(seconds))} ${plural(Math.max(1, Math.ceil(seconds)), "second")}`;
  if (seconds < 3600) {
    const minutes = Math.ceil(seconds / 60);
    return `in ${minutes} ${plural(minutes, "minute")}`;
  }
  const hours = Math.ceil(seconds / 3600);
  return `in ${hours} ${plural(hours, "hour")}`;
}

function plural(count: number, unit: string): string {
  return count === 1 ? unit : `${unit}s`;
}
