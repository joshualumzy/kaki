import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_KINDS, aiCast, humanRoles, type Scenario } from '@kaki/shared';
import { colleagueAskNote, guestCardNote } from '../../src/host/autoDispatch';
import { NpcConversation, type NpcPorts } from '../../src/npc/conversation';
import type { Utterance } from '../../src/npc/director';
import { loadScenario } from '../../src/loadScenario';

afterEach(() => vi.useRealTimers());

/** The AI cast for the seat a person takes: the host and one colleague they can ask. */
function castFor(scenario: Scenario, role: string): { cast: ReturnType<typeof aiCast>; host: string; colleague: string } {
  const seat = scenario.attendees.find((attendee) => attendee.role === role)!.name;
  const cast = aiCast(scenario, seat);
  return {
    cast,
    host: cast.find((npc) => npc.role === 'host')!.attendee,
    colleague: cast.find((npc) => npc.role !== 'host')!.attendee,
  };
}

/** The task-title shapes the Note Taker makes for a topic, one per action kind plus the common prose shapes. */
function taskTitles(item: Scenario['agenda'][number]): string[] {
  const topic = item.spoken ?? item.title;
  const shapeFor = (kind: string): string => {
    switch (kind) {
      case 'gitea_issue':
        return `File the ${topic} issue`;
      case 'mattermost_post':
        return `Post the ${topic} decision in the team channel`;
      case 'email':
        return `Email the supplier about the ${topic}`;
      case 'wiki_page':
        return `Update the ${topic} wiki page`;
      default:
        return `Book the ${topic} review`;
    }
  };
  return [
    `Draft the ${topic} follow-up`,
    `${topic} follow-up note`,
    `Confirm ${topic} deployment timing for opening policy`,
    ...ACTION_KINDS.map(shapeFor),
  ];
}

/** A conversation in the kopitiam meeting with `replies` fed to the fake model, one per turn. */
function meeting(scenario: Scenario, role: string, cast: ReturnType<typeof aiCast>, replies: string[]) {
  const spoken: string[] = [];
  const logs: string[] = [];
  let reply = 0;
  const ports: NpcPorts<Utterance> = {
    async *stream() {
      const next = replies[reply++] ?? '';
      if (next.length > 0) yield next;
    },
    async synthesize(utterance) {
      return utterance;
    },
    async play(_speaker, clip) {
      spoken.push(clip.text);
    },
    emitTranscript() {},
    emitState() {},
    log(message) {
      logs.push(message);
    },
  };
  const conversation = new NpcConversation(ports, {
    scenario: { ...scenario, npcs: cast },
    responseDelayMs: 0,
    speakerGapMs: 0,
    sentenceGapMs: 0,
    observeDelayMs: 60_000,
    silencePromptMs: 60_000,
    firstIdeaCatch: false,
    replies: 'legacy',
  });
  conversation.setHuman({ name: 'Josh', role });
  return { conversation, spoken, logs };
}

describe('asking a colleague through the model', () => {
  it('never speaks a task title, even when the model reads it out', async () => {
    vi.useFakeTimers();
    const scenario = await loadScenario('kopitiam');
    const role = humanRoles(scenario)[0]!.id;
    const { cast, host, colleague } = castFor(scenario, role);

    for (const item of scenario.agenda) {
      for (const shape of taskTitles(item)) {
        const h = meeting(scenario, role, cast, [`${host}: ${colleague}, could you ${shape}?`]);
        h.conversation.agendaMoved(item.title);
        let heard: boolean | undefined;
        h.conversation.askColleague(colleague, colleagueAskNote(host, colleague, shape), {
          forbiddenText: shape,
          onDone: (spoken) => {
            heard = spoken;
          },
        });
        await h.conversation.settled();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.spoken.join(' ').toLowerCase(), shape).not.toContain(shape.toLowerCase());
        expect(heard, shape).toBe(false);
        expect(h.logs.some((line) => line.includes('[dispatch]')), shape).toBe(true);
        h.conversation.close();
      }
    }
  });

  it('speaks a natural request and lets the colleague answer afterwards', async () => {
    vi.useFakeTimers();
    const scenario = await loadScenario('kopitiam');
    const role = humanRoles(scenario)[0]!.id;
    const { cast, host, colleague } = castFor(scenario, role);
    const h = meeting(scenario, role, cast, [`${host}: ${colleague}, can you take that on after this?`]);
    h.conversation.agendaMoved(scenario.agenda[0]!.title);
    let heard: boolean | undefined;
    h.conversation.askColleague(colleague, colleagueAskNote(host, colleague, 'Confirm kiosk wording deployment timing'), {
      forbiddenText: 'Confirm kiosk wording deployment timing',
      onDone: (spoken) => {
        heard = spoken;
      },
    });
    await h.conversation.settled();
    expect(heard).toBe(true);
    expect(h.spoken).toEqual([`${colleague}, can you take that on after this?`]);
    expect(h.spoken.join(' ')).not.toContain('Confirm kiosk wording deployment timing');
    h.conversation.close();
  });
});

describe('the visitor card pointer', () => {
  it('never speaks a task title in the card pointer either', async () => {
    vi.useFakeTimers();
    const scenario = await loadScenario('kopitiam');
    const role = humanRoles(scenario)[0]!.id;
    const { cast, host } = castFor(scenario, role);
    for (const item of scenario.agenda) {
      for (const shape of taskTitles(item)) {
        const h = meeting(scenario, role, cast, [`${host}: Josh, the follow-up for ${shape} is on your screen.`]);
        h.conversation.agendaMoved(item.title);
        let heard: boolean | undefined;
        h.conversation.pointAtCard(guestCardNote(host, 'Josh'), {
          forbiddenText: shape,
          onDone: (spoken) => {
            heard = spoken;
          },
        });
        await h.conversation.settled();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.spoken.join(' ').toLowerCase(), shape).not.toContain(shape.toLowerCase());
        expect(heard, shape).toBe(false);
        h.conversation.close();
      }
    }
  });

  it('is spoken once per topic and never carries a task title', async () => {
    vi.useFakeTimers();
    const scenario = await loadScenario('kopitiam');
    const role = humanRoles(scenario)[0]!.id;
    const { cast, host } = castFor(scenario, role);
    const h = meeting(scenario, role, cast, [
      `${host}: Josh, the follow-up's on your screen whenever you're ready.`,
      `${host}: Josh, the follow-up's still on your screen.`,
    ]);
    h.conversation.agendaMoved(scenario.agenda[0]!.title);
    h.conversation.pointAtCard(guestCardNote(host, 'Josh'));
    h.conversation.pointAtCard(guestCardNote(host, 'Josh'));
    await h.conversation.settled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spoken).toEqual(["Josh, the follow-up's on your screen whenever you're ready."]);
    expect(h.logs.some((line) => line.includes('already pointed'))).toBe(true);
    h.conversation.close();
  });

  it('gives the pointer back when the model says nothing, so a later cue can point', async () => {
    vi.useFakeTimers();
    const scenario = await loadScenario('kopitiam');
    const role = humanRoles(scenario)[0]!.id;
    const { cast, host } = castFor(scenario, role);
    const h = meeting(scenario, role, cast, [
      '',
      `${host}: Josh, the follow-up's on your screen whenever you want to send it.`,
    ]);
    h.conversation.agendaMoved(scenario.agenda[0]!.title);
    h.conversation.pointAtCard(guestCardNote(host, 'Josh'));
    await h.conversation.settled();
    h.conversation.pointAtCard(guestCardNote(host, 'Josh'));
    await h.conversation.settled();
    expect(h.spoken).toEqual(["Josh, the follow-up's on your screen whenever you want to send it."]);
    h.conversation.close();
  });
});
