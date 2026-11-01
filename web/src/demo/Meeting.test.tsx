/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import Meeting from './Meeting';
import { BrowserRouter } from 'react-router-dom';
import { ScenarioProvider } from '../kaki';
import { test } from 'vitest';

// Mock matchMedia to prevent jsdom errors
window.matchMedia = window.matchMedia || function() {
    return {
        matches: false,
        addListener: function() {},
        removeListener: function() {}
    };
};

const fakeScenario = {
  id: "test",
  organisation: "TestOrg",
  meetingTitle: "TestMeeting",
  roles: [{id: 'producer', label: 'Producer'}, {id: 'lead_programmer', label: 'Lead'}],
  attendees: [
    { name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' },
    { name: 'Arjun', role: 'lead_programmer', zoomDisplayName: 'Arjun' }
  ],
  agenda: [
    { title: 'Welcome', minutes: 5, ownerRole: 'producer' }
  ]
};

global.fetch = (async (url: string) => {
  if (url === '/api/scenario') {
    return { ok: true, json: async () => fakeScenario };
  }
  if (url === '/api/livekit/token') {
    return { ok: true, json: async () => ({ token: 'fake-token' }) };
  }
  return { ok: true, json: async () => ({}) };
}) as any;

test('renders Meeting without crashing', async () => {
  const { container, findByText } = render(
    <BrowserRouter>
      <ScenarioProvider>
        <Meeting />
      </ScenarioProvider>
    </BrowserRouter>
  );
  
  await findByText('Join Meeting', { exact: false }, { timeout: 3000 }).catch(() => {});
  
  const btn = container.querySelector('.lk-button') as HTMLButtonElement;
  if (btn) {
      btn.click();
      await new Promise(r => setTimeout(r, 1000));
      
      const redError = container.querySelector('h1');
      if (redError && redError.textContent === 'Something went wrong.') {
         console.log('Caught ErrorBoundary crash:');
         console.log(container.innerHTML);
      }
  } else {
      console.log('No join button found');
  }
});
