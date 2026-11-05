import { describe, expect, it } from 'vitest';
import type { KakiEvent, Scenario, Task } from '@kaki/shared';
import { entryForEvent, entryForTask, hostName } from './timeline';

const scenario = {
  roles: [{ id: 'chef', label: 'Chef' }],
  npcs: [
    { attendee: 'Sam', role: 'host' },
    { attendee: 'Arjun', role: 'participant' },
  ],
} as unknown as Scenario;
const viewer = { name: 'Joshua', seatName: 'Wei Ling' };

const said = (speaker: string): KakiEvent => ({
  type: 'TRANSCRIPT_CHUNK',
  audience: { kind: 'all' },
  payload: { speaker, text: 'Hello.', timestamp: '2026-11-05T10:00:00Z' },
});

describe('timeline entries', () => {
  it('shows the visitor under their own name', () => {
    expect(entryForEvent(said('Wei Ling'), scenario, viewer)).toMatchObject({ kind: 'said', who: 'Joshua (you)' });
    expect(entryForEvent(said('Arjun'), scenario, viewer)).toMatchObject({ who: 'Arjun' });
  });

  it('lists the host cues, opening included, as the host character', () => {
    const cue: KakiEvent = {
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: { kind: 'OPENING', text: 'Welcome.' },
    };
    expect(entryForEvent(cue, scenario, viewer)).toMatchObject({ kind: 'host', who: 'Sam', text: 'Welcome.' });
    expect(hostName({ ...scenario, npcs: [] } as Scenario)).toBe('Host');
  });

  it('gives the same line the same key, so a replay after reconnecting is not listed twice', () => {
    expect(entryForEvent(said('Arjun'), scenario, viewer)?.key).toBe(entryForEvent(said('Arjun'), scenario, viewer)?.key);
  });

  it('leaves the agenda record out; it has its own card', () => {
    const record = { type: 'MEETING_RECORD_UPDATED', audience: { kind: 'screen' }, payload: {} } as unknown as KakiEvent;
    expect(entryForEvent(record, scenario, viewer)).toBeUndefined();
  });
});

describe('task entries', () => {
  const task = { id: 't1', title: 'Fix the oven', suggestedAssignee: 'chef', assignee: 'chef', status: 'CLAIMED' } as Task;
  it('says who a task went to and when they accepted it', () => {
    expect(entryForTask({ ...task, status: 'DISPATCHED' }, 'SUGGESTED', scenario)?.text).toBe('Task sent to Chef: Fix the oven');
    expect(entryForTask(task, 'DISPATCHED', scenario)?.text).toBe('Task accepted by Chef: Fix the oven');
  });
  it('says nothing when the status did not change', () => {
    expect(entryForTask(task, 'CLAIMED', scenario)).toBeUndefined();
  });

  it('shows the host cues as lines to say when a person hosts', () => {
    const cue: KakiEvent = {
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: { kind: 'TIMEOUT', text: 'Build is at 10 minutes, please wrap up.' },
    };
    expect(entryForEvent(cue, scenario, viewer, true)).toMatchObject({ kind: 'suggest', who: 'You could say' });
    expect(entryForEvent(cue, scenario, viewer)).toMatchObject({ kind: 'host', who: 'Sam' });
  });
});
