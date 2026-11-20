import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LoginPage } from './auth/LoginPage';
import { ScenarioProvider, viewForPath } from './kaki';
import { PhonePage } from './phone/PhonePage';
import { ScreenPage } from './screen/ScreenPage';
import { SetupPage } from './setup/SetupPage';
import { LandingPage } from './landing/LandingPage';
import { OwnerMeetingPage } from './meeting/OwnerMeetingPage';
import { ParticipantJoinPage } from './meeting/ParticipantJoinPage';
import Meeting from './demo/Meeting';

/** Load the scenario the current page needs: the practice pack on practice routes. */
function ScenarioShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ScenarioProvider view={viewForPath(location.pathname)}>{children}</ScenarioProvider>;
}

/** Route shell for the single Kaki web app: shared screen, phone, and a redirect home. */
export function App() {
  return (
    <div className="app-shell">
      <ScenarioShell>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/practice" element={<Meeting variant="practice" />} />
          <Route path="/demo" element={<Meeting variant="practice" />} />
          <Route path="/join" element={<ParticipantJoinPage />} />
          <Route path="/meeting" element={<OwnerMeetingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/screen" element={<ScreenPage />} />
          <Route path="/phone" element={<PhonePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ScenarioShell>
    </div>
  );
}
