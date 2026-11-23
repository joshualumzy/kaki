import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ScenarioProvider, viewForPath } from './kaki';
import { LandingPage } from './landing/LandingPage';
import { PracticePage } from './meeting/PracticePage';
import { JoinPage } from './product/JoinPage';
import { NewMeetingPage } from './product/NewMeetingPage';
import { RealMeetingRoom } from './product/RealMeetingRoom';
import { SignInPage } from './product/SignInPage';
import { WorkspacePage } from './product/WorkspacePage';
import { MeetingHistoryPage } from './product/MeetingHistoryPage';
import './product/product.css';

/** Load the scenario the current page needs: the practice pack on practice routes. */
function ScenarioShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ScenarioProvider view={viewForPath(location.pathname)}>{children}</ScenarioProvider>;
}

/** The front page. Any other unhandled address goes home. */
function LegacyRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
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
        <Route path="/workspaces/:id/meetings/:meetingId" element={<MeetingHistoryPage />} />
        <Route path="/m/:id/room" element={<RealMeetingRoom />} />
        <Route path="/m/:id" element={<JoinPage />} />
        {/* The public practice URLs stay; each visitor's room is resolved from their own cookie. */}
        <Route path="/practice" element={<PracticePage />} />
        <Route path="/demo" element={<PracticePage />} />
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
