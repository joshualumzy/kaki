import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LoginPage } from './auth/LoginPage';
import { ScenarioProvider, viewForPath } from './kaki';
import { SetupPage } from './setup/SetupPage';
import { LandingPage } from './landing/LandingPage';
import { OwnerMeetingPage } from './meeting/OwnerMeetingPage';
import { ParticipantJoinPage } from './meeting/ParticipantJoinPage';
import Meeting from './meeting/room/Meeting';
import { JoinPage } from './product/JoinPage';
import { NewMeetingPage } from './product/NewMeetingPage';
import { RealMeetingRoom } from './product/RealMeetingRoom';
import { SignInPage } from './product/SignInPage';
import { WorkspacePage } from './product/WorkspacePage';
import './product/product.css';

/** Load the scenario the current page needs: the practice pack on practice routes. */
function ScenarioShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ScenarioProvider view={viewForPath(location.pathname)}>{children}</ScenarioProvider>;
}

/** The legacy pages, kept exactly as they were; they still need the scenario. */
function LegacyRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/practice" element={<Meeting variant="practice" />} />
      <Route path="/demo" element={<Meeting variant="practice" />} />
      <Route path="/join" element={<ParticipantJoinPage />} />
      <Route path="/meeting" element={<OwnerMeetingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** The single Kaki web app: real-product pages and the legacy meeting room side by side. */
export function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/new" element={<NewMeetingPage />} />
        <Route path="/workspaces/:id" element={<WorkspacePage />} />
        <Route path="/m/:id/room" element={<RealMeetingRoom />} />
        <Route path="/m/:id" element={<JoinPage />} />
        <Route
          path="*"
          element={
            <ScenarioShell>
              <LegacyRoutes />
            </ScenarioShell>
          }
        />
      </Routes>
    </div>
  );
}
