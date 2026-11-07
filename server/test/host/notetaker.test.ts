import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import { createNotetaker, isGrounded, isLikelyDuplicate, isLikelyDuplicateQuestion, parseNotetakerReply } from '../../src/host/notetaker';
import { loadReplay, type ReplayLine } from '../../src/host/replay';
import { createFakeLlm, type ChatMessage } from '../../src/llm';
import { loadScenario } from '../../src/loadScenario';
import { createTaskStore } from '../../src/tasks';

function quietHub(): Hub {
  return {
    publish: (_event: KakiEvent) => {},
    subscribe: () => () => {},
    onCommand: () => {},
    clearRetained: () => {},
    close: () => {},
  };
}

function reply(body: Record<string, unknown>): string {
  return JSON.stringify({ newQuestions: [], answeredQuestionIds: [], newTasks: [], ...body });
}

function userMessage(messages: ChatMessage[]): string {
  return messages.find((message) => message.role === 'user')?.content ?? '';
}

// Just the transcript part of the prompt, so canned replies do not match echoed questions.
function newLines(messages: ChatMessage[]): string {
  return userMessage(messages).split('New transcript lines:')[1] ?? '';
}

let scenario: Scenario;
let replay: ReplayLine[];

beforeAll(async () => {
  scenario = await loadScenario('kopitiam');
  replay = await loadReplay(scenario, 'kopitiam');
});

// The replay lines between two script times, as a canned transcript slice.
function slice(from: number, to: number): ReplayLine[] {
  return replay.filter((line) => line.at >= from && line.at < to);
}

function setup(respond: Parameters<typeof createFakeLlm>[0], startIndex = 0) {
  const tasks = createTaskStore({ hub: quietHub(), scenario });
  const llm = createFakeLlm(respond);
  let agendaIndex = startIndex;
  const onAgendaIndex = vi.fn((index: number) => {
    agendaIndex = index;
  });
  const notetaker = createNotetaker({ scenario, tasks, llm, agendaIndex: () => agendaIndex, onAgendaIndex });
  const feed = (lines: ReplayLine[]) => lines.forEach((line) => notetaker.addChunk(line));
  return { tasks, llm, notetaker, feed, onAgendaIndex };
}

describe('notetaker on canned Nanyang Kopi & Toast slices', () => {
  it('suggests the scripted tasks and records the scripted questions', async () => {
    const { tasks, llm, notetaker, feed } = setup((messages) => {
      const text = newLines(messages);
      if (text.includes('file a ticket for the kiosk label experiment')) {
        return reply({
          newQuestions: [{ text: 'Do tourists or locals struggle more at the kiosk?', forRole: 'game_designer' }],
          newTasks: [
            {
              title: 'File the kiosk label experiment ticket',
              context: 'Track the kiosk label experiment with the 19 of 28 trial numbers.',
              suggestedAssignee: 'game_designer',
              actionKind: 'gitea_issue',
              evidence: 'Mei, can you file a ticket for the kiosk label experiment so it is tracked with the trial numbers?',
            },
          ],
        });
      }
      if (text.includes('How many solo diners actually need a table')) {
        return reply({
          agendaIndex: 1,
          newQuestions: [{ text: 'How many solo diners need a table between eight and ten?', forRole: 'producer' }],
        });
      }
      if (text.includes('who runs cash')) {
        return reply({
          agendaIndex: 2,
          newQuestions: [{ text: 'Who runs cash, and how is the change float balanced at close?', forRole: 'producer' }],
        });
      }
      if (text.includes('email Zack')) {
        return reply({
          agendaIndex: 3,
          newTasks: [
            {
              title: 'Email Zack to confirm the re-taste',
              context: 'Confirm the 8:30am re-taste and the standard butter portion.',
              suggestedAssignee: 'marketing_lead',
              actionKind: 'email',
              evidence: "Yes, I'll email Zack tonight and confirm the details.",
            },
            {
              title: 'Post the final plan in the team channel',
              context: 'Post the agreed launch plan in the team channel once the butter decision is settled.',
              suggestedAssignee: 'producer',
              actionKind: 'mattermost_post',
              evidence: "I'll post the final plan in the team channel once we settle the butter decision.",
            },
          ],
        });
      }
      return reply({});
    });

    for (const [from, to] of [
      [0, 360],
      [360, 1000],
      [1000, 1450],
      [1450, 2200],
    ] as const) {
      feed(slice(from, to));
      await notetaker.run();
    }

    expect(llm.calls).toHaveLength(4);
    expect(tasks.list().map((task) => [task.suggestedAssignee, task.actionKind, task.status])).toEqual([
      ['game_designer', 'gitea_issue', 'SUGGESTED'],
      ['marketing_lead', 'email', 'SUGGESTED'],
      ['producer', 'mattermost_post', 'SUGGESTED'],
    ]);
    expect(notetaker.state().openQuestions).toEqual([
      { id: 'q-1', text: 'Do tourists or locals struggle more at the kiosk?', forRole: 'game_designer' },
      { id: 'q-2', text: 'How many solo diners need a table between eight and ten?', forRole: 'producer' },
      { id: 'q-3', text: 'Who runs cash, and how is the change float balanced at close?', forRole: 'producer' },
    ]);
    expect(notetaker.state().status).toBe('ok');
  });

  it('tells the LLM who spoke, what is open and what was already suggested', async () => {
    const { llm, notetaker, feed } = setup((_messages, call) =>
      call === 0
        ? reply({
            newQuestions: [{ text: 'Do tourists or locals struggle more at the kiosk?' }],
            newTasks: [
              {
                title: 'File the kiosk label experiment ticket',
                context: 'Track the kiosk label experiment.',
                suggestedAssignee: 'game_designer',
                evidence: 'Nineteen of them froze',
              },
            ],
          })
        : reply({}),
    );

    feed(slice(0, 100));
    await notetaker.run();
    feed(slice(100, 200));
    await notetaker.run();

    const [system, user] = llm.calls[1]!;
    expect(system!.content).toContain('lead_programmer: Tech & POS Lead (Arjun)');
    expect(system!.content).toContain('1. Morning seat crunch & laptop campers');
    expect(user!.content).toContain('- q-1: Do tourists or locals struggle more at the kiosk?');
    expect(user!.content).toMatch(/- task-[\w-]+: File the kiosk label experiment ticket \(owner: game_designer\) — Track the kiosk label experiment\./);
    expect(user!.content).toContain('[Arjun (Tech & POS Lead)] When we tested that at Tampines');
    // Only lines added since the last pass are sent.
    expect(user!.content).not.toContain('Yesterday');
  });
});

describe('notetaker record keeping', () => {
  it('does not repeat a task or question the meeting already has, and drops answered questions', async () => {
    const task = {
      title: 'Review the kiosk trial',
      context: 'c',
      suggestedAssignee: 'game_designer',
      evidence: "Mei, let's start with the kiosk.",
    };
    const { tasks, notetaker, feed } = setup((_messages, call) =>
      [
        reply({ newTasks: [task], newQuestions: [{ text: 'Kiosk trial split?' }] }),
        reply({ newTasks: [{ ...task, title: 'review the kiosk trial' }], newQuestions: [{ text: 'kiosk trial split' }] }),
        reply({ answeredQuestionIds: ['q-1'] }),
      ][call]!,
    );

    for (let pass = 0; pass < 3; pass += 1) {
      feed(slice(0, 30));
      await notetaker.run();
    }

    expect(tasks.list()).toHaveLength(1);
    expect(notetaker.state().openQuestions).toEqual([]);
  });

  it('keeps a re-asked question when the same reply closes the older wording', async () => {
    const { notetaker, feed } = setup((_messages, call) =>
      [
        reply({ newQuestions: [{ text: 'Where do players quit?' }] }),
        reply({ answeredQuestionIds: ['q-1'], newQuestions: [{ text: 'Where do players quit in the game?' }] }),
      ][call]!,
    );

    for (let pass = 0; pass < 2; pass += 1) {
      feed(slice(0, 30));
      await notetaker.run();
    }

    expect(notetaker.state().openQuestions.map((question) => question.text)).toEqual(['Where do players quit in the game?']);
  });

  it('only moves the agenda forward', async () => {
    const { notetaker, feed, onAgendaIndex } = setup(
      (_messages, call) => reply({ agendaIndex: [0, 2, 1][call] }),
      1,
    );

    for (let pass = 0; pass < 3; pass += 1) {
      feed(slice(0, 30));
      await notetaker.run();
    }

    expect(onAgendaIndex.mock.calls).toEqual([[2]]);
  });

  it('keeps the last good record when the LLM is down, then resends the missed lines', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let down = false;
    const { llm, notetaker, feed } = setup(() => {
      if (down) throw new Error('gateway unreachable');
      return reply({ newQuestions: [{ text: 'Kiosk trial split?' }] });
    });

    feed(slice(0, 30));
    await notetaker.run();

    down = true;
    feed(slice(30, 100));
    await notetaker.run();
    expect(notetaker.state()).toMatchObject({
      status: 'stale',
      lastError: 'gateway unreachable',
      openQuestions: [{ id: 'q-1', text: 'Kiosk trial split?' }],
    });

    down = false;
    feed(slice(100, 130));
    await notetaker.run();
    expect(notetaker.state().status).toBe('ok');
    const resent = userMessage(llm.calls[2]!);
    expect(resent).toContain('Nineteen of them froze');
    expect(resent).toContain('Seventy-two percent');
  });

  it('treats a reply that is not JSON as a failed pass', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { notetaker, feed } = setup(() => 'Sure! Here are the tasks: ...');

    feed(slice(0, 30));
    await notetaker.run();

    expect(notetaker.state().status).toBe('stale');
  });

  it('runs one pass at a time', async () => {
    let release: (value: string) => void = () => {};
    const { llm, notetaker, feed } = setup(() => new Promise<string>((resolve) => (release = resolve)));

    feed(slice(0, 30));
    const first = notetaker.run();
    feed(slice(30, 60));
    await notetaker.run();
    expect(llm.calls).toHaveLength(1);

    release(reply({}));
    await first;
  });

  it('without an LLM only keeps talk time', async () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario });
    const notetaker = createNotetaker({ scenario, tasks, agendaIndex: () => 0 });

    notetaker.addChunk({ speaker: 'Arjun', text: 'one two three four five' });
    await notetaker.run();

    expect(notetaker.state()).toMatchObject({ status: 'off', openQuestions: [] });
    expect(notetaker.state().talkSecondsFor(0)).toEqual({ lead_programmer: 2 });
  });
});

describe('task precision', () => {
  const candidate = (title: string, suggestedAssignee: string, evidence: string, extra = {}) => ({
    title,
    context: title,
    suggestedAssignee,
    evidence,
    ...extra,
  });

  it('drops a task whose evidence nobody said', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tasks, notetaker, feed } = setup(() =>
      reply({
        newTasks: [
          candidate('Order new office chairs', 'producer', 'Wei Ling promised to order new chairs for everyone'),
          candidate('Check the docket print change', 'lead_programmer', 'drink prep slowed by fifteen seconds a cup'),
        ],
      }),
    );

    feed(slice(120, 160));
    await notetaker.run();

    expect(tasks.list().map((task) => task.title)).toEqual(['Check the docket print change']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Order new office chairs'));
  });

  it('skips tasks the LLM marks as duplicates and reworded duplicates for the same role', async () => {
    const { tasks, notetaker, feed } = setup((_messages, call) =>
      [
        reply({
          newTasks: [
            candidate('Review kiosk trial numbers', 'game_designer', 'Nineteen of them froze'),
            candidate('Check butter margin', 'producer', 'where are we with Zack'),
          ],
        }),
        reply({
          newTasks: [
            candidate('Review the kiosk trial freeze', 'game_designer', 'Nineteen of them froze'),
            candidate('Track the kiosk trial freeze', 'game_designer', 'Nineteen of them froze', {
              duplicateOf: 'task-1',
            }),
            candidate(
              'Post the butter plan in the team channel',
              'producer',
              "I'll post the final plan in the team channel",
            ),
          ],
        }),
      ][call]!,
    );

    feed([...slice(0, 100), ...slice(1450, 1460)]);
    await notetaker.run();
    feed([...slice(100, 200), ...slice(1970, 1990)]);
    await notetaker.run();

    expect(tasks.list().map((task) => task.title)).toEqual([
      'Review kiosk trial numbers',
      'Check butter margin',
      'Post the butter plan in the team channel',
    ]);
  });

  it('matches evidence word for word and compares tasks by their keywords', () => {
    const lines = [{ text: "Yes, I'll file it today. I think it's the order queue." }];
    expect(isGrounded("I'll file it today", lines)).toBe(true);
    expect(isGrounded('Yes, I will definitely raise a ticket', lines)).toBe(false);
    expect(isGrounded('file it', lines)).toBe(false);

    const existing = [
      { id: 't', title: 'Fix pause menu text overlap', context: '', suggestedAssignee: 'lead_programmer', status: 'SUGGESTED', updatedAt: '' },
    ] as const;
    const same = { title: 'Pause menu text overlaps on small screens', context: '', suggestedAssignee: 'lead_programmer' };
    expect(isLikelyDuplicate(same, [...existing])).toBe(true);
    expect(isLikelyDuplicate({ ...same, suggestedAssignee: 'producer' }, [...existing])).toBe(false);
    expect(
      isLikelyDuplicate({ title: 'Fix tutorial skip button', context: '', suggestedAssignee: 'lead_programmer' }, [...existing]),
    ).toBe(false);
  });

  it('says how many lines it had to drop during a long outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { notetaker } = setup(() => reply({}));

    for (let line = 0; line < 205; line += 1) notetaker.addChunk({ speaker: 'Arjun', text: `line ${line}` });
    await notetaker.run();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped the 5 oldest transcript lines'));
  });

  it('keeps the agreed decision in the task context without appending raw speech fragments', async () => {
    const kopitiamScenario = await loadScenario('kopitiam');
    const tasks = createTaskStore({ hub: quietHub(), scenario: kopitiamScenario });
    const decision =
      'Announce in the team channel today that we decided to move the cash box away from the food prep area.';
    const llm = createFakeLlm(() =>
      reply({
        newTasks: [
          candidate(
            'Post cash box decision in team channel',
            'producer',
            'Feifei Li, could you post that decision in the team channel today so everyone has it?',
            { context: decision, actionKind: 'mattermost_post' },
          ),
        ],
      }),
    );
    const notetaker = createNotetaker({ scenario: kopitiamScenario, tasks, llm, agendaIndex: () => 1 });
    notetaker.addChunk({ speaker: 'Feifei Li', text: 'We should separate cash collection from food prep.' });
    notetaker.addChunk({ speaker: 'Arjun', text: 'Move the counter?' });
    notetaker.addChunk({ speaker: 'Feifei Li', text: 'Whatever that that that that box. Away from the food, right?' });
    notetaker.addChunk({ speaker: 'Mei', text: 'So we move the cash box away from the food prep area.' });
    notetaker.addChunk({
      speaker: 'Mei',
      text: 'Feifei Li, could you post that decision in the team channel today so everyone has it?',
    });
    await notetaker.run();

    const [task] = tasks.list();
    expect(task?.context).toBe(decision);
    expect(task?.context).not.toContain('Whatever that that that that box');
    expect(task?.context).not.toContain('Move the counter?');
  });

  it('routes a natural second-person task request ("Could you post...") to the visitor role even when zoomDisplayName has no parentheses', async () => {
    const kopitiamScenario = await loadScenario('kopitiam');
    const tasks = createTaskStore({ hub: quietHub(), scenario: kopitiamScenario });
    const llm = createFakeLlm(() =>
      reply({
        newTasks: [
          candidate(
            'Post kiosk English subtitles decision in team channel',
            'game_designer',
            'Feifei Li, could you post that decision in the team channel today so everyone has it?',
            { actionKind: 'mattermost_post' },
          ),
        ],
      }),
    );
    const notetaker = createNotetaker({ scenario: kopitiamScenario, tasks, llm, agendaIndex: () => 1 });
    notetaker.addChunk({ speaker: 'Wei Ling', text: 'Let us add the Simple English toggle on the kiosk.' });
    notetaker.addChunk({
      speaker: 'Mei',
      text: 'Got it, we will build the Simple English toggle tonight. Feifei Li, could you post that decision in the team channel today so everyone has it?',
    });
    await notetaker.run();
    expect(tasks.list()).toHaveLength(1);
    expect(tasks.list()[0]?.suggestedAssignee).toBe('producer');
  });
});

describe('talk time', () => {
  it('counts talk time per role for each agenda item', async () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario });
    let agendaIndex = 0;
    const notetaker = createNotetaker({ scenario, tasks, agendaIndex: () => agendaIndex });

    for (const line of replay) {
      agendaIndex = line.agendaIndex ?? agendaIndex;
      notetaker.addChunk(line);
    }
    notetaker.addChunk({ speaker: 'Kaki', text: 'Not an attendee, so not counted.' });

    const state = notetaker.state();
    expect(Object.keys(state.talkSecondsFor(1)).sort()).toEqual(['game_designer', 'lead_programmer', 'producer']);
    expect(state.talkSecondsFor(1).producer).toBeGreaterThan(state.talkSecondsFor(1).game_designer!);
    expect(state.talkSecondsFor(3).marketing_lead).toBeGreaterThan(0);
  });

  it('spots a role that barely speaks', () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario });
    const notetaker = createNotetaker({ scenario, tasks, agendaIndex: () => 0 });

    for (let line = 0; line < 30; line += 1) {
      notetaker.addChunk({ speaker: 'Wei Ling', text: 'one two three four five six seven eight nine ten' });
    }
    notetaker.addChunk({ speaker: 'Daniel', text: 'Short.' });

    expect(notetaker.state().quietRoles).toContain('marketing_lead');
  });

  it('calls nobody quiet before there is enough talk to judge', () => {
    const tasks = createTaskStore({ hub: quietHub(), scenario });
    const notetaker = createNotetaker({ scenario, tasks, agendaIndex: () => 0 });

    notetaker.addChunk({ speaker: 'Arjun', text: 'Short update.' });

    expect(notetaker.state().quietRoles).toEqual([]);
  });
});

describe('notetaker reply parsing', () => {
  it('drops items that do not fit the scenario and keeps the rest', () => {
    const parsed = parseNotetakerReply(
      '```json\n' +
        JSON.stringify({
          agendaIndex: 9,
          newQuestions: [{ text: 'Who owns QA?', forRole: 'qa_lead' }, { text: '' }, 'nope'],
          answeredQuestionIds: ['q-1', 3],
          newTasks: [
            {
              title: 'Book tablets',
              context: 'For the booth.',
              suggestedAssignee: 'producer',
              actionKind: 'fax',
              evidence: 'we save about four hundred',
            },
            { title: 'No evidence', context: 'x', suggestedAssignee: 'producer' },
            { title: 'Ghost task', context: 'x', suggestedAssignee: 'qa_lead' },
            { context: 'no title', suggestedAssignee: 'producer' },
          ],
        }) +
        '\n```',
      scenario,
    );

    expect(parsed).toEqual({
      agendaIndex: undefined,
      newQuestions: [{ text: 'Who owns QA?' }],
      answeredQuestionIds: ['q-1'],
      newTasks: [
        { title: 'Book tablets', context: 'For the booth.', suggestedAssignee: 'producer', evidence: 'we save about four hundred' },
      ],
    });
  });

  it('rejects a reply that is not a JSON object', () => {
    expect(() => parseNotetakerReply('[]', scenario)).toThrow(/object/);
    expect(() => parseNotetakerReply('nope', scenario)).toThrow(/JSON/);
  });
});

describe('isLikelyDuplicateQuestion', () => {
  it('catches the same question worded differently, but not a different one', () => {
    const open = ['When is the butter decision?'];
    expect(isLikelyDuplicateQuestion('When will the butter decision be made?', open)).toBe(true);
    expect(isLikelyDuplicateQuestion('How many solo diners need a table?', open)).toBe(false);
  });

  it('does not treat a short question as a repeat just because a long one contains "is it"', () => {
    const long = 'Do we know exactly where in level 5 players quit — is it the first rush, the second stall, or the end?';
    expect(isLikelyDuplicateQuestion(long, ['Is it the timer?'])).toBe(false);
    expect(isLikelyDuplicateQuestion('Is it the timer?', [long])).toBe(false);
  });

  it('still catches a reworded repeat of a short question', () => {
    expect(isLikelyDuplicateQuestion('Is the timer the cause?', ['Is it the timer?'])).toBe(true);
  });
});
