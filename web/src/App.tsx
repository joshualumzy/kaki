import { Route, Routes } from 'react-router-dom';
import { LandingPage } from './landing/LandingPage';
import { PracticePage } from './meeting/PracticePage';
import { JoinPage } from './product/JoinPage';
import { JoinWorkspacePage } from './product/JoinWorkspacePage';
import { NewMeetingPage } from './product/NewMeetingPage';
import { NotFoundPage } from './product/NotFoundPage';
import { RealMeetingRoom } from './product/RealMeetingRoom';
import { SignInPage } from './product/SignInPage';
import { WorkspacePage } from './product/WorkspacePage';
import { MeetingHistoryPage } from './product/MeetingHistoryPage';
import './product/product.css';

/** The single Kaki web app: real-product pages and the practice meeting. */
export function App() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/new" element={<NewMeetingPage />} />
        <Route path="/join-workspace/:token" element={<JoinWorkspacePage />} />
        <Route path="/workspaces/:id" element={<WorkspacePage />} />
        <Route path="/workspaces/:id/meetings/:meetingId" element={<MeetingHistoryPage />} />
        <Route path="/m/:id/room" element={<RealMeetingRoom />} />
        <Route path="/m/:id" element={<JoinPage />} />
        {/* Each visitor's practice room is resolved from their own cookie. */}
        <Route path="/practice" element={<PracticePage />} />
        <Route path="/" element={<LandingPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </div>
  );
}
