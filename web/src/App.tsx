import { Navigate, Route, Routes } from 'react-router-dom';
import { ScenarioProvider } from './kaki';
import { PhonePage } from './phone/PhonePage';
import { ScreenPage } from './screen/ScreenPage';

/** Route shell for the single Kaki web app: shared screen, phone, and a redirect home. */
export function App() {
  return (
    <div className="app-shell">
      <ScenarioProvider>
        <Routes>
          <Route path="/screen" element={<ScreenPage />} />
          <Route path="/phone" element={<PhonePage />} />
          <Route path="*" element={<Navigate to="/screen" replace />} />
        </Routes>
      </ScenarioProvider>
    </div>
  );
}
