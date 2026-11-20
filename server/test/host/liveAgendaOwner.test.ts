import { afterEach, expect, it, vi } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import { createMeetingModule } from '../../src/host/meeting';
import { createFakeLlm } from '../../src/llm';
import type { Hub } from '../../src/hub';
import type { TaskStore } from '../../src/tasks';
import { testScenario } from '../fixtures/scenario';

afterEach(() => vi.useRealTimers());

it('does not let the live notetaker move the agenda from a model guess', async () => {
  vi.useFakeTimers();
  const events: KakiEvent[] = [];
  const listeners: Array<(event: KakiEvent) => void> = [];
  const hub = {
    publish(event: KakiEvent) { events.push(event); for (const listener of listeners) listener(event); },
    subscribe(listener: (event: KakiEvent) => void) {
      listeners.push(listener);
      return () => { listeners.splice(listeners.indexOf(listener), 1); };
    },
    onCommand() {}, clearRetained() {}, close() {},
  } as Hub;
  const tasks = {
    list: () => [], onChange: () => () => {}, reset() {},
  } as unknown as TaskStore;
  const scenario = { ...testScenario, agenda: [...testScenario.agenda,
    { title: 'Second topic', minutes: 2, canWait: false, deadline: 'before doors open at 8', ownerRole: testScenario.agenda[0]!.ownerRole }] };
  const llm = createFakeLlm(() => JSON.stringify({ agendaIndex: 1, newQuestions: [], answeredQuestionIds: [], answeredQuestions: [], newTasks: [], revisions: [] }));
  const stop = createMeetingModule({ llm, notetakerIntervalMs: 5 }).start({ hub, tasks, activeScenario: () => scenario });
  hub.publish({ type: 'MEETING_STARTED', audience: { kind: 'all' }, payload: { meetingId: 'meeting-1', startedAt: new Date().toISOString() } });
  hub.publish({ type: 'TRANSCRIPT_CHUNK', audience: { kind: 'screen' }, payload: {
    speaker: testScenario.attendees[0]!.zoomDisplayName, text: 'Let us discuss the second topic early.', timestamp: new Date().toISOString(),
  } });
  await vi.advanceTimersByTimeAsync(30);
  const records = events.filter((event): event is Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }> =>
    event.type === 'MEETING_RECORD_UPDATED');
  expect(records.length).toBeGreaterThan(0);
  expect(records.every((event) => event.payload.agendaIndex === 0)).toBe(true);
  if (typeof stop === 'function') stop();
});
