import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from './auth/LoginPage';
import { ScenarioProvider } from './kaki';
import { PhonePage } from './phone/PhonePage';
import { ScreenPage } from './screen/ScreenPage';
import { SetupPage } from './setup/SetupPage';
import Meeting from './demo/Meeting';

/** Route shell for the single Kaki web app: shared screen, phone, and a redirect home. */
export function App() {
  return (
    <div className="app-shell">
      <ScenarioProvider>
        <Routes>
          <Route path="/" element={<Meeting />} />
          <Route path="/demo" element={<Meeting />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/screen" element={<ScreenPage />} />
          <Route path="/phone" element={<PhonePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ScenarioProvider>
    </div>
  );
}
