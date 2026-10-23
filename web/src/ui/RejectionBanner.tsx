/** Visible banner for a command the server rejected. */
export function RejectionBanner({ message }: { message: string }) {
  return (
    <p className="connection-banner" role="alert">
      Command rejected — {message}
    </p>
  );
}
