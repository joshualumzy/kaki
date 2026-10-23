/** Visible warning shown whenever the live connection is down. */
export function ConnectionBanner() {
  return (
    <p className="connection-banner" role="status">
      Disconnected — reconnecting…
    </p>
  );
}
