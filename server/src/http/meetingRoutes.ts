import type { RoutedRoute } from './routeCall';
import { handleLivekitToken, handleMeetingClose, handleMeetingCode, handleMeetingEndPractice, handleMeetingOpen, handleMeetingParticipants, handleMeetingStart, handleMeetingState } from './routes/meeting';
import { handleCalendarEvent, handleMattermostOpen, handleScenario, handleScenarioFull } from './routes/scenario';
import { handleEmit, handleHumanLine, handleMeetingMemory, handleSettleTopic, handleSuggestTask } from './routes/runner';
import { handleGetSetup, handleGetSetupTools, handleImportCalendar, handlePutSetup, handleSetupBlank, handleSetupToolTest } from './routes/setup';

/**
 * Every route one meeting answers. The access check runs once, before any handler, and an unlisted
 * path is a 404. The app serves these under `/api` for the legacy instance and under
 * `/api/meetings/:id` for every other one, so the handlers and access levels are exactly shared.
 */
export function buildMeetingRouteTable({ devRoutes }: { devRoutes: boolean }): RoutedRoute[] {
  const routes: RoutedRoute[] = [
    { method: 'GET', path: '/api/meeting/state', access: 'public', handle: handleMeetingState },
    { method: 'GET', path: '/api/meeting/participants', access: 'host', handle: handleMeetingParticipants },
    { method: 'GET', path: '/api/meeting-code', access: 'host', handle: handleMeetingCode },
    { method: 'GET', path: '/api/runner/meeting-state', access: 'service', handle: handleMeetingState },
    { method: 'POST', path: '/api/livekit/token', access: 'public', handle: handleLivekitToken },
    { method: 'POST', path: '/api/meeting/start', access: 'host-or-practice', handle: handleMeetingStart },
    { method: 'POST', path: '/api/meeting/open', access: 'host', handle: handleMeetingOpen },
    { method: 'POST', path: '/api/meeting/close', access: 'host', handle: handleMeetingClose },
    { method: 'POST', path: '/api/meeting/end-practice', access: 'host', handle: handleMeetingEndPractice },
    { method: 'GET', path: '/api/mattermost/open', access: 'session', handle: handleMattermostOpen },
    { method: 'GET', path: '/api/calendar/:id', access: 'public', handle: handleCalendarEvent },
    { method: 'GET', path: '/api/scenario', access: 'public', handle: handleScenario },
    { method: 'GET', path: '/api/scenario/full', access: 'service', handle: handleScenarioFull },
    { method: 'GET', path: '/api/setup', access: 'session', handle: handleGetSetup },
    { method: 'GET', path: '/api/setup/tools', access: 'host', handle: handleGetSetupTools },
    { method: 'POST', path: '/api/setup/tools/:kind/test', access: 'host', handle: handleSetupToolTest },
    { method: 'PUT', path: '/api/setup', access: 'host', handle: handlePutSetup },
    { method: 'POST', path: '/api/setup/blank', access: 'host', handle: handleSetupBlank },
    { method: 'POST', path: '/api/setup/import-calendar', access: 'host', handle: handleImportCalendar },
    { method: 'POST', path: '/api/runner/emit', access: 'service', handle: handleEmit },
    { method: 'POST', path: '/api/runner/human-line', access: 'service', handle: handleHumanLine },
    { method: 'POST', path: '/api/runner/suggest-task', access: 'service', handle: handleSuggestTask },
    { method: 'POST', path: '/api/runner/meeting-memory', access: 'service', handle: handleMeetingMemory },
    { method: 'POST', path: '/api/runner/settle-topic', access: 'service', handle: handleSettleTopic },
  ];

  if (devRoutes) {
    routes.push(
      { method: 'POST', path: '/dev/emit', access: 'dev', handle: handleEmit },
      { method: 'POST', path: '/dev/suggest-task', access: 'dev', handle: handleSuggestTask },
      { method: 'POST', path: '/dev/meeting-memory', access: 'dev', handle: handleMeetingMemory },
      { method: 'POST', path: '/dev/settle-topic', access: 'dev', handle: handleSettleTopic },
    );
  }
  return routes;
}
