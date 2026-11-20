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
    expect(entryForEvent(said('Wei Ling'), viewer)).toMatchObject({ kind: 'said', who: 'Joshua (you)' });
    expect(entryForEvent(said('Arjun'), viewer)).toMatchObject({ who: 'Arjun' });
  });

  it('does not list the AI host\'s cues when they are published: the spoken line arrives as a transcript line', () => {
    const cue: KakiEvent = {
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: { kind: 'OPENING', text: 'Welcome.' },
    };
    expect(entryForEvent(cue, viewer)).toBeUndefined();
    expect(hostName({ ...scenario, npcs: [] } as Scenario)).toBe('Host');
  });

  it('marks a line that began while the previous person was still speaking', () => {
    const overlapping: KakiEvent = {
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: { speaker: 'Arjun', text: 'I agree.', timestamp: '2026-11-05T10:00:01Z', overlap: true },
    };
    expect(entryForEvent(overlapping, viewer)?.text).toBe('I agree. (overlapping speech)');
  });

  it('gives the same line the same key, so a replay after reconnecting is not listed twice', () => {
    expect(entryForEvent(said('Arjun'), viewer)?.key).toBe(entryForEvent(said('Arjun'), viewer)?.key);
  });

  it('replaces a cut transcript line under the same id instead of listing it twice', () => {
    const full: KakiEvent = {
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: {
        speaker: 'Arjun',
        text: 'The build is red and the crash only happens on Android.',
        timestamp: '2026-11-05T10:00:00Z',
        lineId: 'line-1',
      },
    };
    const cut: KakiEvent = {
      type: 'TRANSCRIPT_LINE_UPDATED',
      audience: { kind: 'all' },
      payload: {
        speaker: 'Arjun',
        text: 'The build is red',
        timestamp: '2026-11-05T10:00:01Z',
        lineId: 'line-1',
        cut: true,
      },
    };
    const first = entryForEvent(full, viewer);
    const replacement = entryForEvent(cut, viewer);
    expect(replacement?.key).toBe(first?.key);
    expect(replacement?.text).toBe('The build is red …');
  });

  it('leaves the agenda record out; it has its own card', () => {
    const record = { type: 'MEETING_RECORD_UPDATED', audience: { kind: 'screen' }, payload: {} } as unknown as KakiEvent;
    expect(entryForEvent(record, viewer)).toBeUndefined();
  });
});

describe('task entries', () => {
  const task = { id: 't1', title: 'Fix the oven', suggestedAssignee: 'chef', assignee: 'chef', status: 'SUGGESTED' } as Task;
  it('says only that Kaki noticed a task, once', () => {
    expect(entryForTask(task, undefined)?.text).toBe('Kaki noticed a task: Fix the oven');
    expect(entryForTask(task, 'SUGGESTED')).toBeUndefined();
  });
  it('leaves every later status to the task list', () => {
    for (const status of ['DISPATCHED', 'CLAIMED', 'DRAFT_READY', 'RUNNING', 'COMPLETED', 'FAILED', 'DISMISSED'] as const) {
      expect(entryForTask({ ...task, status }, 'SUGGESTED')).toBeUndefined();
    }
  });
});
