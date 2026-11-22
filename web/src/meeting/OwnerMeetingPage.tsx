import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '../auth/useMe';
import Meeting from './room/Meeting';
import { Button, Card } from '../ui';

/** The owner's room: only the signed-in owner may open it when sign-in is on. */
export function OwnerMeetingPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const auth = useMe(reloadKey);

  if (auth.status === 'loading') {
    return (
      <main className="page">
        <p className="empty-state">Checking sign-in…</p>
      </main>
    );
  }

  if (auth.status === 'error') {
    return (
      <main className="page">
        <Card title="Could not check sign-in">
          <p className="connection-banner" role="alert">
            {auth.message}
          </p>
          <Button variant="ghost" onClick={() => setReloadKey((key) => key + 1)}>
            Try again
          </Button>
        </Card>
      </main>
    );
  }

  if (auth.me.authEnabled && auth.me.kind !== 'host') {
    return <Navigate to="/login?return=/meeting" replace />;
  }

  return <Meeting variant="owner" />;
}
