import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiCast, humanRoles, parseScenario, shuffleAgendaForRole, type Scenario, type SuggestInput } from '@kaki/shared';
import { NpcConversation, type ConversationOptions, type NpcPorts, type NpcUiState } from '../../src/npc/conversation';
import { buildSystemPrompt, type Utterance } from '../../src/npc/director';

const fullScenario = parseScenario(JSON.parse(readFileSync(new URL('../../../scenarios/kopitiam/scenario.json', import.meta.url), 'utf8')));
const control = (state: 'open' | 'settled' | 'deferred', title = 'Share the agreed decision') =>
  `KAKI_CONTROL ${JSON.stringify({ state, followUp: { kind: 'mattermost_post', title }, wingmanNeeded: false })}`;

function meeting(
  scenario: Scenario,
  role: string,
  replies: Array<string | string[] | (() => AsyncIterable<string>)>,
  overrides: Partial<ConversationOptions> = {},
  portOverrides: Partial<NpcPorts<Utterance>> = {},
) {
  const seat = scenario.attendees.find((attendee) => attendee.role === role)!.name;
  const cast = aiCast(scenario, seat);
  const tasks: SuggestInput[] = [];
  const spoken: string[] = [];
  const captions: string[] = [];
  const logs: string[] = [];
  const states: NpcUiState[] = [];
  let reply = 0;
  let index = 0;
  let ended = 0;
  let conversation: NpcConversation<Utterance>;
  const ports: NpcPorts<Utterance> = {
    async *stream() {
      const chunks = replies[reply++] ?? `${control('open')}\n${cast[0]!.attendee}: Tell me more.`;
      if (typeof chunks === 'function') { yield* chunks(); return; }
      for (const chunk of Array.isArray(chunks) ? chunks : [chunks]) yield chunk;
    },
    async synthesize(utterance) { return utterance; },
    async play(_speaker, clip) { spoken.push(clip.text); },
    emitTranscript(_speaker, text) { captions.push(text); },
    emitState(state) { states.push(state); },
    log(message) { logs.push(message); },
    settleTopic(input) { tasks.push(input); },
    advanceAgenda() { index += 1; conversation.agendaMoved(scenario.agenda[index]?.title); },
    endMeeting() { ended += 1; },
    ...portOverrides,
  };
  conversation = new NpcConversation(ports, {
    scenario: { ...scenario, npcs: cast }, responseDelayMs: 0,
    speakerGapMs: 0, sentenceGapMs: 0, openLiveGraceMs: 1,
    observeDelayMs: 60_000, silencePromptMs: 60_000,
    ...overrides,
  });
  conversation.setHuman({ name: 'Visitor', role });
  conversation.agendaMoved(scenario.agenda[0]!.title);
  const say = async (line: string) => {
    conversation.humanTyped(line);
    await vi.advanceTimersByTimeAsync(0);
    await conversation.settled();
  };
  return { conversation, tasks, spoken, captions, logs, states, say, index: () => index, ended: () => ended, replies: () => reply };
}

afterEach(() => vi.useRealTimers());

describe('never-stuck visitor path', () => {
  it('uses each topic discussion and keeps the visitor as decider even in their own seat', () => {
    for (const role of humanRoles(fullScenario)) {
      const item = fullScenario.agenda.find((candidate) => candidate.ownerRole === role.id)!;
      const seat = fullScenario.attendees.find((attendee) => attendee.role === role.id)!.name;
      const cast = aiCast(fullScenario, seat);
      const prompt = buildSystemPrompt({ ...fullScenario, npcs: cast },
        { name: 'Visitor', role: role.id }, item.title);
      expect(prompt).toContain('Visitor decides this item regardless of seat');
      expect(prompt).toContain(item.title);
      expect(prompt).not.toContain(`${seat}'s fact for this item`);
      expect(prompt).toContain('answer each other briefly');
      expect(prompt).toContain(role.label);
    }
  });
  for (const role of humanRoles(fullScenario)) {
    it(`sends a follow-up on both topics and ends for ${role.label}`, async () => {
      vi.useFakeTimers();
      const agenda = shuffleAgendaForRole(fullScenario, role.id, () => 0.1, 2);
      const scenario = { ...fullScenario, agenda };
      const seat = scenario.attendees.find((attendee) => attendee.role === role.id)!.name;
      const colleagues = aiCast(scenario, seat).filter((npc) => npc.role !== 'host').slice(0, 2);
      const replies = agenda.flatMap((_item, n) => [
        `${control('open')}\n${colleagues[0]!.attendee}: Here is the problem.\n${colleagues[1]!.attendee}: What is your call?`,
        `${control('settled', `Post decision ${n + 1}`)}\n${colleagues[0]!.attendee}: Could you Post decision ${n + 1}?`,
      ]);
      const h = meeting(scenario, role.id, replies, { observeDelayMs: 1500 });
      h.conversation.announce('Sam', 'Welcome to the huddle.');
      await vi.advanceTimersByTimeAsync(0);
      expect(h.spoken).toContain('Welcome to the huddle.');
      for (let n = 0; n < 2; n += 1) {
        await vi.advanceTimersByTimeAsync(1500);
        await h.conversation.settled();
        expect(h.spoken).toContain('Here is the problem.');
        expect(h.spoken).toContain('What is your call?');
        await h.say(`I choose a workable plan for ${agenda[n]!.title}.`);
        expect(h.tasks[n]).toMatchObject({ agendaItemTitle: agenda[n]!.title, suggestedAssignee: role.id });
        expect(h.tasks[n]!.context).toContain(`I choose a workable plan for ${agenda[n]!.title}.`);
        expect(h.spoken).toContain(`Could you Post decision ${n + 1}?`);
        h.conversation.taskStatus(`task-${n}`, agenda[n]!.title, 'DISPATCHED', true);
        h.conversation.taskStatus(`task-${n}`, agenda[n]!.title, 'SYNCED', true);
        await vi.advanceTimersByTimeAsync(2);
      }
      expect(h.index()).toBe(1);
      expect(h.ended()).toBe(1);
      expect(h.tasks).toHaveLength(2);
      h.conversation.close();
    });
  }

  const decisions = [
    "Okay, so let's open the window bar.", 'Right, open the window bar.',
    'No, we keep the kitchen open with fresh stock.', 'Hmm, I think we should use the window bar.',
    "I'll put the stools at the window bar.", 'I will make sure the chef shows the receipt.',
    'Post a staff member at the door.', 'Send the family an apology and pay the bill.',
    'Put table signs on the booths.', 'Open the side door for deliveries.',
    'Keep the ten booths for diners.', 'Switch the wall sockets off during breakfast.',
    'Give solo diners the window seats.', 'Use both counters for the morning rush.',
    'Let the chef check each fresh tray.', 'I choose the smaller menu.',
    'We should trial the new ordering screen.', 'Try a short queue outside.',
    'Actually, keep the old names on receipts.', 'Make the labels larger.',
    'Launch the office platter first.', 'Hold the discount until margins are checked.',
    'Let staff guide first-time customers.', 'Move laptops away from the booths.',
    'Close only the affected fridge.', 'Document the disposal immediately.',
    'Use a direct pickup code.', 'I back the window bar plan.',
    'My decision is to split the queue.', 'Do the slower option to protect quality.',
    'Yes, set up the signs before opening.', 'Sure, give Auntie Mary help at the door.',
    'Wait, use fresh stock instead.', 'Thanks, I choose the office bundle.',
    'File the receipt with the inspection notes.', 'Write the seating policy today.',
    'We can absorb this cost once.', 'Give the hospital a goodwill payment.',
    'Let us hold the kopi price and explain it at the counter.', 'The staff should lead the rollout.',
  ];
  it('settles forty differently worded decisions when the streamed control says settled', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const scenario = { ...fullScenario, agenda: [fullScenario.agenda[0]!] };
    const speaker = aiCast(scenario, scenario.attendees.find((a) => a.role === role)!.name)[0]!.attendee;
    expect(decisions).toHaveLength(40);
    for (const decision of decisions) {
      const h = meeting(scenario, role, [`${control('settled')}\n${speaker}: Could you Share the agreed decision?`]);
      await h.say(decision);
      expect(h.tasks, decision).toHaveLength(1);
      expect(h.tasks[0]!.context, decision).toContain(decision);
      h.conversation.close();
    }
  });

  it.each([
    'Sam: I hear you.',
    'KAKI_CONTROL {bad json}\nSam: I hear you.',
    `Sam: I hear you.\n${control('settled')}`,
  ])('keeps an open path for missing, malformed or late control: %s', async (reply) => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role, [reply]);
    await h.say('Use the window bar.');
    expect(h.tasks).toHaveLength(0);
    expect(h.spoken).toContain('I hear you.');
    h.conversation.lockDecision();
    expect(h.tasks).toHaveLength(1);
    h.conversation.close();
  });

  it('records the decision once: repeated lines and plain questions are left out', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role, []);
    await h.say('Use the window bar.');
    await h.say('Before I call it, what is the practical catch for the team?');
    await h.say('My call stands: it frees seats.');
    await h.say('  my call stands: it frees seats. ');
    h.conversation.lockDecision();
    expect(h.tasks).toHaveLength(1);
    expect(h.tasks[0]!.decisionSource).toBe('Use the window bar. My call stands: it frees seats.');
    h.conversation.close();
  });

  it('parses a control line split across chunks without speaking it', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const reply = `${control('settled')}\nSam: Could you Share the agreed decision?`;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role, [reply.split('')]);
    await h.say('Use the window bar.');
    expect(h.tasks).toHaveLength(1);
    expect(h.spoken).toEqual(['Could you Share the agreed decision?']);
    h.conversation.close();
  });

  it('reads the control line when the reply starts with blank lines', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const reply = `\n \n${control('settled')}\nSam: Could you Share the agreed decision?`;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role, [['\n', ' \n', reply.slice(3)]]);
    await h.say('Use the window bar.');
    expect(h.tasks).toHaveLength(1);
    expect(h.spoken).toEqual(['Could you Share the agreed decision?']);
    h.conversation.close();
  });

  it('keeps sure and an early task on this topic until the visitor task is synced', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const title = fullScenario.agenda[0]!.title;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('open')}\nSam: Tell me more.`, `${control('settled')}\nSam: Could you Share the agreed decision?`,
        `${control('open')}\nSam: Thanks.`]);
    h.conversation.taskStatus('early', title, 'SYNCED', true);
    await h.say('I am considering the window bar.');
    expect(h.ended()).toBe(0);
    await h.say('Use the window bar.');
    expect(h.tasks).toHaveLength(1);
    h.conversation.taskStatus('new', title, 'DISPATCHED', true);
    await h.say('sure');
    await vi.advanceTimersByTimeAsync(10);
    expect(h.ended()).toBe(0);
    h.conversation.taskStatus('new', title, 'SYNCED', true);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.ended()).toBe(1);
    h.conversation.close();
  });

  it('offers once after the turn budget and locks after two unanswered prompts', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('open')}\nSam: I hear you.`], { topicTurnBudget: 1, budgetSilenceMs: 2 });
    await h.say('Use the window bar.');
    await vi.advanceTimersByTimeAsync(510);
    expect(h.spoken.filter((line) => line.includes('shall we lock in'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.spoken).toContain('Shall I lock in what you’ve said now?');
    expect(h.tasks).toHaveLength(1);
    h.conversation.close();
  });

  it('nudges the visitor towards their card at 20 s without moving on', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('settled')}\nSam: Could you Share the agreed decision?`],
      { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 });
    await h.say('Use the window bar.');
    await vi.advanceTimersByTimeAsync(19_000);
    expect(h.spoken.some((line) => line.includes('your draft is on your card'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await h.conversation.settled();
    expect(h.spoken.filter((line) => line.includes('your draft is on your card'))).toHaveLength(1);
    expect(h.spoken.some((line) => line.includes('need to move on'))).toBe(false);
    expect(h.ended()).toBe(0);
    h.conversation.close();
  });

  it('moves on at 45 s when the card is still untouched', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('settled')}\nSam: Could you Share the agreed decision?`],
      { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 });
    await h.say('Use the window bar.');
    await vi.advanceTimersByTimeAsync(44_999);
    await h.conversation.settled();
    expect(h.spoken.some((line) => line.includes('need to move on'))).toBe(false);
    expect(h.ended()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await h.conversation.settled();
    expect(h.spoken.some((line) => line.includes('need to move on'))).toBe(true);
    expect(h.ended()).toBe(1);
    h.conversation.close();
  });

  it('restarts the review window when the visitor makes progress on the card, without another nudge', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const title = fullScenario.agenda[0]!.title;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('settled')}\nSam: Could you Share the agreed decision?`],
      { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 });
    await h.say('Use the window bar.');
    await vi.advanceTimersByTimeAsync(20_000);
    await h.conversation.settled();
    expect(h.spoken.filter((line) => line.includes('your draft is on your card'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    h.conversation.taskStatus('task-0', title, 'DISPATCHED', true);
    await vi.advanceTimersByTimeAsync(15_000);
    await h.conversation.settled();
    expect(h.spoken.some((line) => line.includes('need to move on'))).toBe(false);
    expect(h.ended()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    await h.conversation.settled();
    expect(h.spoken.filter((line) => line.includes('your draft is on your card'))).toHaveLength(1);
    expect(h.logs.some((line) => line.includes('skipped the card nudge'))).toBe(true);
    h.conversation.close();
  });

  it('names an invite on the card when the follow-up is a calendar event', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const calendarControl = `KAKI_CONTROL ${JSON.stringify({ state: 'settled',
      followUp: { kind: 'calendar_event', title: 'Book the follow-up call' }, wingmanNeeded: false })}`;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${calendarControl}\nSam: I will book that in.`], { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 });
    await h.say('Use the window bar.');
    await vi.advanceTimersByTimeAsync(20_000);
    await h.conversation.settled();
    expect(h.spoken.some((line) => line.includes('your invite is on your card'))).toBe(true);
    expect(h.spoken.some((line) => line.includes('your draft is on your card'))).toBe(false);
    h.conversation.close();
  });

  it('skips the card nudge when the host already pointed at the card in the last 30 seconds', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('settled')}\nSam: Have a look on your screen on the right to review and confirm.`],
      { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 });
    await h.say('Use the window bar.');
    expect(h.spoken).toContain('Have a look on your screen on the right to review and confirm.');
    await vi.advanceTimersByTimeAsync(20_000);
    await h.conversation.settled();
    expect(h.spoken.some((line) => line.includes('your draft is on your card'))).toBe(false);
    expect(h.logs.some((line) => line.includes('skipped the card nudge'))).toBe(true);
    await vi.advanceTimersByTimeAsync(25_000);
    await h.conversation.settled();
    expect(h.spoken.some((line) => line.includes('need to move on'))).toBe(true);
    h.conversation.close();
  });

  it('drops a sentence a colleague already said in the last minute, and logs it', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const scenario = { ...fullScenario, agenda: [fullScenario.agenda[0]!] };
    const seat = scenario.attendees.find((attendee) => attendee.role === role)!.name;
    const colleague = aiCast(scenario, seat).filter((npc) => npc.role !== 'host')[0]!.attendee;
    const first = "Anyone new on the till needs a login, and that's about fifteen minutes out of my hour before opening.";
    const repeated = "Anyone new on the till needs a login, and that's about fifteen minutes of my hour, untested until we open.";
    const h = meeting(scenario, role, [
      `${control('open')}\n${colleague}: ${first}`,
      `${control('open')}\n${colleague}: The catch is time. ${repeated}`,
    ]);
    await h.say('Okay.');
    expect(h.spoken).toContain(first);
    await h.say('Tell me more.');
    expect(h.spoken).toContain('The catch is time.');
    expect(h.spoken).not.toContain(repeated);
    expect(h.logs.some((line) => line.startsWith('[repeat]') && line.includes(colleague))).toBe(true);
    h.conversation.close();
  });

  it('nudges only once in a review sequence', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('settled')}\nSam: Could you Share the agreed decision?`],
      { reviewNudgeMs: 20_000, reviewWindowMs: 45_000 });
    await h.say('Use the window bar.');
    await vi.advanceTimersByTimeAsync(20_000);
    await h.conversation.settled();
    await vi.advanceTimersByTimeAsync(24_999);
    await h.conversation.settled();
    expect(h.spoken.filter((line) => line.includes('your draft is on your card'))).toHaveLength(1);
    h.conversation.close();
  });

  it('warns before a review window expires and ends the topic', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('settled')}\nSam: Could you Share the agreed decision?`], { reviewWindowMs: 1 });
    await h.say('Use the window bar.');
    expect(h.ended()).toBe(0);
    await vi.advanceTimersByTimeAsync(510);
    expect(h.spoken.some((line) => line.includes('need to move on'))).toBe(true);
    expect(h.ended()).toBe(1);
    h.conversation.close();
  });

  it('resumes the completion grace after Stop so a synced topic can end', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const title = fullScenario.agenda[0]!.title;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('settled')}\nSam: Could you Share the agreed decision?`], { openLiveGraceMs: 20 });
    await h.say('Use the window bar.');
    h.conversation.taskStatus('sent', title, 'SYNCED', true);
    h.conversation.stop();
    await vi.advanceTimersByTimeAsync(30);
    expect(h.ended()).toBe(0);
    h.conversation.resumeFromPause();
    await vi.advanceTimersByTimeAsync(30);
    expect(h.ended()).toBe(1);
    h.conversation.close();
  });

  it('resumes the review window after Stop so an unfinished topic can end', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('settled')}\nSam: Could you Share the agreed decision?`], { reviewWindowMs: 20 });
    await h.say('Use the window bar.');
    h.conversation.stop();
    await vi.advanceTimersByTimeAsync(30);
    expect(h.ended()).toBe(0);
    h.conversation.resumeFromPause();
    await vi.advanceTimersByTimeAsync(550);
    expect(h.ended()).toBe(1);
    h.conversation.close();
  });

  it('restores the review window when typing resumes a stopped meeting', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('settled')}\nSam: Could you Share the agreed decision?`, `${control('open')}\nSam: Thanks.`],
      { reviewWindowMs: 20 });
    await h.say('Use the window bar.');
    h.conversation.stop();
    await h.say('I will check the card.');
    await vi.advanceTimersByTimeAsync(550);
    expect(h.ended()).toBe(1);
    h.conversation.close();
  });

  it('does not schedule a callback from a reply that began before Skip', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: fullScenario.agenda.slice(0, 2) }, role, [
      async function* () {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        yield `${control('open')}\nSam: Let me check Kaki and get back to you in a minute.`;
      },
    ], { observeDelayMs: 60_000, silencePromptMs: 60_000 });
    h.conversation.humanTyped('What are the figures?');
    await vi.advanceTimersByTimeAsync(0);
    h.conversation.agendaMoved(fullScenario.agenda[1]!.title);
    await vi.advanceTimersByTimeAsync(10);
    await h.conversation.settled();
    await vi.advanceTimersByTimeAsync(45_010);
    expect(h.replies()).toBe(1);
    h.conversation.close();
  });

  it('reoffers budget recovery after a visitor clarification leaves the topic open', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`${control('open')}\nSam: What would work?`, `${control('open')}\nSam: Thanks for clarifying.`],
      { topicTurnBudget: 1, budgetSilenceMs: 20 });
    await h.say('Use the window bar.');
    await vi.advanceTimersByTimeAsync(510);
    expect(h.spoken.filter((line) => line.includes('shall we lock in'))).toHaveLength(1);
    await h.say('Could we keep a seat for walk-ins?');
    await vi.advanceTimersByTimeAsync(510);
    expect(h.spoken.filter((line) => line.includes('shall we lock in'))).toHaveLength(2);
    h.conversation.close();
  });

  it.each(['\t', '   ', '\u00a0'])('never speaks or captions a malformed control header separated by %j', async (separator) => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [`KAKI_CONTROL${separator}{bad json}\nSam: Tell me more.`]);
    await h.say('Use the window bar.');
    expect(h.tasks).toHaveLength(0);
    expect(h.spoken, h.logs.join('\n')).toEqual(['Tell me more.']);
    expect(h.captions).not.toContain(`KAKI_CONTROL${separator}{bad json}`);
    h.conversation.close();
  });

  it('treats a newline immediately after the control token as a malformed hidden header', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      ['KAKI_CONTROL\nSam: Tell me more.']);
    await h.say('Use the window bar.');
    expect(h.spoken).toEqual(['Tell me more.']);
    h.conversation.close();
  });

  it('keeps Lock enabled while the model thinks after a visitor line', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const h = meeting({ ...fullScenario, agenda: [fullScenario.agenda[0]!] }, role,
      [async function* () { await new Promise<void>(() => undefined); }]);
    h.conversation.humanTyped('Use the window bar.');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.states.at(-1)).toMatchObject({ kind: 'thinking', canLock: true });
    h.conversation.lockDecision();
    expect(h.tasks).toHaveLength(1);
    h.conversation.close();
  });

  it('briefs the room after the observe delay when nothing interrupts it', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const scenario = { ...fullScenario, agenda: [fullScenario.agenda[0]!] };
    const seat = scenario.attendees.find((attendee) => attendee.role === role)!.name;
    const colleagues = aiCast(scenario, seat).filter((npc) => npc.role !== 'host').slice(0, 2);
    const h = meeting(scenario, role,
      [`${control('open')}\n${colleagues[0]!.attendee}: Here is the problem.\n${colleagues[1]!.attendee}: What is your call?`],
      { observeDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await h.conversation.settled();
    expect(h.spoken).toContain('Here is the problem.');
    expect(h.spoken).toContain('What is your call?');
    h.conversation.close();
  });

  it('still briefs after a pause and resume during the scripted opening', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const scenario = { ...fullScenario, agenda: [fullScenario.agenda[0]!] };
    const seat = scenario.attendees.find((attendee) => attendee.role === role)!.name;
    const colleagues = aiCast(scenario, seat).filter((npc) => npc.role !== 'host').slice(0, 2);
    const h = meeting(scenario, role,
      [`${control('open')}\n${colleagues[0]!.attendee}: Here is the problem.\n${colleagues[1]!.attendee}: What is your call?`],
      { observeDelayMs: 100 });
    h.conversation.announce('Sam', 'Welcome to the huddle, Daniel. Walk us through what happened.');
    h.conversation.stop();
    h.conversation.resumeFromPause();
    await vi.advanceTimersByTimeAsync(100);
    await h.conversation.settled();
    expect(h.spoken).toContain('Walk us through what happened.');
    expect(h.spoken).toContain('Here is the problem.');
    expect(h.spoken).toContain('What is your call?');
    h.conversation.close();
  });

  it('briefs once the room frees after being busy past the old retry window', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const scenario = { ...fullScenario, agenda: [fullScenario.agenda[0]!] };
    const seat = scenario.attendees.find((attendee) => attendee.role === role)!.name;
    const colleagues = aiCast(scenario, seat).filter((npc) => npc.role !== 'host').slice(0, 2);
    const slowSynthesize: Partial<NpcPorts<Utterance>> = {
      async synthesize(utterance) {
        if (utterance.speaker === 'Sam') await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
        return utterance;
      },
    };
    const h = meeting(scenario, role,
      [`${control('open')}\n${colleagues[0]!.attendee}: Here is the problem.\n${colleagues[1]!.attendee}: What is your call?`],
      { observeDelayMs: 100 }, slowSynthesize);
    h.conversation.announce('Sam', 'Let me set the scene for a while.');
    await vi.advanceTimersByTimeAsync(30_000);
    await h.conversation.settled();
    expect(h.logs.some((line) => line.includes('could not brief'))).toBe(false);
    expect(h.spoken).toContain('Here is the problem.');
    expect(h.spoken).toContain('What is your call?');
    h.conversation.close();
  });

  it('reopens Lock and logs an error when follow-up creation fails', async () => {
    vi.useFakeTimers();
    const role = humanRoles(fullScenario)[0]!.id;
    const scenario = { ...fullScenario, agenda: [fullScenario.agenda[0]!] };
    const states: NpcUiState[] = [];
    const logs: string[] = [];
    const settleTopic = vi.fn().mockRejectedValue(new Error('HTTP 503'));
    const conversation = new NpcConversation({
      async *stream() {}, async synthesize(utterance) { return utterance; }, async play() {},
      emitTranscript() {}, emitState(state) { states.push(state); }, log(message) { logs.push(message); },
      settleTopic,
    }, { scenario, responseDelayMs: 60_000 });
    conversation.setHuman({ name: 'Visitor', role });
    conversation.agendaMoved(scenario.agenda[0]!.title);
    conversation.humanTyped('Use the window bar.');
    conversation.lockDecision();
    await Promise.resolve();
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({ kind: 'idle', canLock: true });
    expect(logs.some((line) => line.includes('ERROR') && line.includes('HTTP 503'))).toBe(true);
    conversation.lockDecision();
    expect(settleTopic).toHaveBeenCalledTimes(2);
    conversation.close();
  });
});
