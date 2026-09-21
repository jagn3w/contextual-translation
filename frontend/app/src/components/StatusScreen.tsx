type Props = {
  message: string;
  onRetry?: (() => void) | undefined;
};

/** Full-page status for loading and for failing to reach the server at all. */
export function StatusScreen({ message, onRetry }: Props) {
  return (
    <main className="grid min-h-screen place-items-center bg-surface px-4">
      <div className="text-center">
        <p role="status" className="text-sm text-muted">
          {message}
        </p>
        {onRetry !== undefined && (
          <button
            type="button"
            onClick={onRetry}
            className="focus-ring mt-4 rounded-md border border-line bg-canvas px-3 py-1.5 text-sm font-medium hover:bg-surface"
          >
            Try again
          </button>
        )}
      </div>
    </main>
  );
}
