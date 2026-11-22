import { afterEach, describe, expect, it } from 'vitest';
import { defaultMeetingSetup, meetingScenarioFromSetup } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { loadScenario } from '../../src/core/loadScenario';
import { buildRunnerMeetingSnapshot } from '../../src/meeting/runnerState';
import { testScenario } from '../fixtures/scenario';

let app: KakiApp | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function appFor(scenario: Awaited<ReturnType<typeof loadScenario>>): Promise<KakiApp> {
  app = await createApp({ speechRecognition: 'browser', scenario, roomRoster: async () => [] });
  return app;
}

describe('the runner meeting snapshot', () => {
  it('uses the draft agenda in the lobby and the sealed agenda once the meeting is running', async () => {
    const pack = await loadScenario('kopitiam');
    const current = await appFor(pack);
    const draft = defaultMeetingSetup(pack);
    const edited = {
      ...draft,
      agenda: draft.agenda.map((item, index) => (index === 0 ? { ...item, minutes: 9 } : item)),
    };
    current.session.setDraft(edited);

    const lobby = buildRunnerMeetingSnapshot({ meetingId: 'meeting-1', session: current.session, fullScenario: pack });
    expect(lobby.phase).toBe('lobby');
    expect(lobby.agenda[0]?.minutes).toBe(9);
    expect(lobby.cast.length).toBeGreaterThan(0);

    const candidate = meetingScenarioFromSetup(pack, edited);
    current.session.beginStart(candidate, edited);
    current.session.commitStart(new Date().toISOString());

    const running = buildRunnerMeetingSnapshot({ meetingId: 'meeting-1', session: current.session, fullScenario: pack });
    expect(running.phase).toBe('running');
    expect(running.started).toBe(true);
    expect(running.agenda[0]?.minutes).toBe(9);
  });

  it('keeps the sealed agenda when the owner edits the setup after Start', async () => {
    const pack = await loadScenario('kopitiam');
    const current = await appFor(pack);
    const draft = defaultMeetingSetup(pack);
    const sealed = {
      ...draft,
      agenda: draft.agenda.map((item, index) => (index === 0 ? { ...item, minutes: 9 } : item)),
    };
    current.session.setDraft(sealed);
    current.session.beginStart(meetingScenarioFromSetup(pack, sealed), sealed);
    current.session.commitStart(new Date().toISOString());

    const nextDraft = {
      ...draft,
      agenda: draft.agenda.map((item, index) => (index === 0 ? { ...item, minutes: 3 } : item)),
    };
    current.session.setDraft(nextDraft);

    const running = buildRunnerMeetingSnapshot({ meetingId: 'meeting-1', session: current.session, fullScenario: pack });
    expect(running.agenda[0]?.minutes).toBe(9);

    current.session.end();
    const ended = buildRunnerMeetingSnapshot({ meetingId: 'meeting-1', session: current.session, fullScenario: pack });
    expect(ended.phase).toBe('ended');
    expect(ended.started).toBe(false);
    expect(ended.agenda[0]?.minutes).toBe(9);

    current.session.reset();
    const reset = buildRunnerMeetingSnapshot({ meetingId: 'meeting-2', session: current.session, fullScenario: pack });
    expect(reset.phase).toBe('lobby');
    // A draft edited after the seal is the next meeting's setup and survives the reset.
    expect(reset.agenda[0]?.minutes).toBe(3);
  });

  it('works for a pack with no AI cast and names no host seat', async () => {
    const current = await appFor(testScenario);
    const lobby = buildRunnerMeetingSnapshot({
      meetingId: 'meeting-1',
      session: current.session,
      fullScenario: testScenario,
    });

    expect(lobby.cast).toEqual([]);
    expect(lobby.hostSeat).toBeUndefined();
    expect(lobby.hostIsHuman).toBe(false);
    expect(lobby.agenda.map((item) => item.title)).toEqual(['Prep']);
  });

  it('reports the active meeting kind, company and attendee names for the recogniser', async () => {
    const current = await appFor(testScenario);
    current.session.setKind('real');
    const state = buildRunnerMeetingSnapshot({
      meetingId: 'meeting-1',
      session: current.session,
      fullScenario: testScenario,
    });

    expect(state.kind).toBe('real');
    expect(state.organisation).toBe(testScenario.organisation);
    expect(state.attendeeNames).toEqual(testScenario.attendees.map((attendee) => attendee.name));
  });

  it('derives host mode from the seat holders, so a runner restart cannot make it stale', async () => {
    const pack = await loadScenario('kopitiam');
    const current = await appFor(pack);
    const before = buildRunnerMeetingSnapshot({ meetingId: 'meeting-1', session: current.session, fullScenario: pack });
    expect(before.hostSeat).toBe('general_manager');
    expect(before.hostIsHuman).toBe(false);

    current.session.addHolder({ name: 'Mia', seat: 'general_manager' });
    const after = buildRunnerMeetingSnapshot({ meetingId: 'meeting-1', session: current.session, fullScenario: pack });
    expect(after.hostIsHuman).toBe(true);
    expect(after.hostName).toBe('Sam');
  });

  it('moves the host name and host profile with the facilitator seat in the effective setup', async () => {
    const pack = await loadScenario('kopitiam');
    const current = await appFor(pack);
    const draft = defaultMeetingSetup(pack);
    const moved = {
      ...draft,
      agenda: [{ id: 'agenda-1', title: 'Opening plan', minutes: 5, ownerRoleId: 'operations_director' }],
      roles: draft.roles.map((role) =>
        role.id === 'tech_pos_lead'
          ? { ...role, facilitator: true }
          : role.id === 'general_manager'
            ? { ...role, facilitator: false }
            : role,
      ),
    };
    current.session.setDraft(moved);

    const state = buildRunnerMeetingSnapshot({ meetingId: 'meeting-1', session: current.session, fullScenario: pack });

    expect(state.hostSeat).toBe('tech_pos_lead');
    expect(state.hostName).toBe('Arjun');
    expect(state.cast.find((npc) => npc.attendee === 'Arjun')?.role).toBe('host');
    expect(state.cast.find((npc) => npc.attendee === 'Sam')?.role).not.toBe('host');
  });
});
