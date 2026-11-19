import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import { installAutoDispatch, shouldStillAskColleague } from '../../src/host/autoDispatch';
import { connectClient, createTestApp, portOf, settle } from '../helpers';
import { testScenario } from '../fixtures/scenario';

describe('auto-dispatch', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it('dispatches a new task to the role named, and Sam says so', () => {
    const published: KakiEvent[] = [];
    app.hub.subscribe((event) => published.push(event));
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario });

    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' });

    expect(app.tasks.get(task.id)).toMatchObject({ status: 'DISPATCHED', assignee: 'chef' });
    const cue = published.find((event) => event.type === 'HOST_SPEECH_TRIGGERED');
    expect(cue).toMatchObject({ payload: { kind: 'DISPATCH' } });
    expect((cue as { payload: { text: string } }).payload.text).toContain('Ada, I\'ve sent you a task: Fix the oven');
    expect((cue as { payload: { assignee?: string; title?: string } }).payload).toMatchObject({ assignee: 'Ada', title: 'Fix the oven' });
  });

  it('leaves the end-of-meeting minutes card waiting for its person, without a dispatch line', () => {
    const published: KakiEvent[] = [];
    app.hub.subscribe((event) => published.push(event));
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario });

    const task = app.tasks.suggest({
      title: 'Publish meeting minutes to the team wiki',
      context: 'The minutes, already drafted.',
      suggestedAssignee: 'chef',
      actionKind: 'wiki_page',
    });

    expect(app.tasks.get(task.id)?.status).toBe('SUGGESTED');
    expect(published.some((event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'DISPATCH')).toBe(false);
  });

  it('leaves a declined task for a person; it is not sent out again', () => {
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario });
    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'Trips the fuse.', suggestedAssignee: 'chef' });
    app.tasks.handleCommand({ type: 'DECLINE_TASK', taskId: task.id }, 'chef');
    expect(app.tasks.get(task.id)?.status).toBe('SUGGESTED');
  });

  it('leaves every task for the host while a person plays the host, and resumes when they leave', () => {
    let human = true;
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario, hostIsHuman: () => human });
    const first = app.tasks.suggest({ title: 'Fix the oven', context: 'x', suggestedAssignee: 'chef' });
    expect(app.tasks.get(first.id)?.status).toBe('SUGGESTED');
    human = false;
    const second = app.tasks.suggest({ title: 'Clean the grill', context: 'x', suggestedAssignee: 'chef' });
    expect(app.tasks.get(second.id)?.status).toBe('DISPATCHED');
  });

  it('dispatches distinct deliverables of the same kind', () => {
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario });
    const first = app.tasks.suggest({ title: 'File crash ticket', context: 'x', suggestedAssignee: 'chef', actionKind: 'gitea_issue' });
    const second = app.tasks.suggest({ title: 'Fix order queue issue', context: 'x', suggestedAssignee: 'chef', actionKind: 'gitea_issue' });
    const differentKind = app.tasks.suggest({ title: 'Post update', context: 'x', suggestedAssignee: 'chef', actionKind: 'mattermost_post' });
    expect(app.tasks.get(first.id)?.status).toBe('DISPATCHED');
    expect(app.tasks.get(second.id)?.status).toBe('DISPATCHED');
    expect(app.tasks.get(differentKind.id)?.status).toBe('DISPATCHED');
  });

  it('holds early live tasks until the topic locks, then releases distinct deliverables', () => {
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario, holdUntilSettled: true });
    const early = app.tasks.suggest({ title: 'Post decision', context: 'x', suggestedAssignee: 'chef',
      actionKind: 'mattermost_post', agendaItemTitle: 'Prep' });
    const distinct = app.tasks.suggest({ title: 'Email supplier', context: 'x', suggestedAssignee: 'chef',
      actionKind: 'email', agendaItemTitle: 'Prep' });
    const duplicate = app.tasks.suggest({ title: 'Post decision', context: 'x', suggestedAssignee: 'chef',
      actionKind: 'mattermost_post', agendaItemTitle: 'Prep' });
    expect(app.tasks.get(early.id)?.status).toBe('SUGGESTED');
    app.hub.publish({ type: 'TOPIC_SETTLED', audience: { kind: 'screen' }, payload: { title: 'Prep', taskId: early.id } });
    expect(app.tasks.get(early.id)?.status).toBe('DISPATCHED');
    expect(app.tasks.get(distinct.id)?.status).toBe('DISPATCHED');
    expect(app.tasks.get(duplicate.id)?.status).toBe('DISMISSED');
  });

  it('dismisses a held task when its topic moves on without settling, so an unresolved topic never gets a card', async () => {
    const published: KakiEvent[] = [];
    app.hub.subscribe((event) => published.push(event));
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario, holdUntilSettled: true });
    const early = app.tasks.suggest({ title: 'Post decision', context: 'x', suggestedAssignee: 'chef',
      actionKind: 'mattermost_post', agendaItemTitle: 'Prep' });
    expect(app.tasks.get(early.id)?.status).toBe('SUGGESTED');
    const screen = await connectClient(portOf(app), 'screen');
    screen.ws.send(JSON.stringify({ type: 'NEXT_AGENDA_ITEM' }));
    await settle();
    expect(app.tasks.get(early.id)?.status).toBe('DISMISSED');
    expect(published.some((event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'DISPATCH')).toBe(false);
    screen.close();
  });

  it('leaves the task for a person when the role is the facilitator', () => {
    const scenario = {
      ...testScenario,
      roles: testScenario.roles.map((role) => (role.id === 'chef' ? { ...role, facilitator: true } : role)),
    };
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => scenario });
    const task = app.tasks.suggest({ title: 'Plan', context: 'x', suggestedAssignee: 'chef' });
    expect(task.status).toBe('SUGGESTED');
    expect(app.tasks.get(task.id)?.status).toBe('SUGGESTED');
  });

  it('leaves the task for a person when nobody in the meeting plays the role', () => {
    const scenario = { ...testScenario, attendees: testScenario.attendees.filter((a) => a.role !== 'chef') };
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => scenario });
    const task = app.tasks.suggest({ title: 'Plan', context: 'x', suggestedAssignee: 'chef' });
    expect(app.tasks.get(task.id)?.status).toBe('SUGGESTED');
  });

  it('says the same words whoever the recipient is, so nobody can tell who is AI', () => {
    const published: KakiEvent[] = [];
    app.hub.subscribe((event) => published.push(event));
    const chef = testScenario.attendees.find((a) => a.role === 'chef')!;
    const asAi = { ...testScenario, npcs: [{ attendee: chef.name, voice: 'v', personality: 'p', agenda: 'a', concerns: [] }] };
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => asAi });
    app.tasks.suggest({ title: 'Fix the oven', context: 'x', suggestedAssignee: 'chef' });
    const cue = published.find((event) => event.type === 'HOST_SPEECH_TRIGGERED') as { payload: { text: string } };
    expect(cue.payload.text).toBe(`${chef.name}, I've sent you a task: Fix the oven. Accept or decline it on your phone.`);
  });

  it('leaves a human recipient to accept it themselves', () => {
    installAutoDispatch({ hub: app.hub, tasks: app.tasks, scenario: () => testScenario });
    const task = app.tasks.suggest({ title: 'Fix the oven', context: 'x', suggestedAssignee: 'chef' });
    expect(app.tasks.get(task.id)?.status).toBe('DISPATCHED');
  });
});

describe('colleagueAskNote', () => {
  it('gives the model the task as context and asks for one spoken sentence, not the title read out', async () => {
    const { colleagueAskNote } = await import('../../src/host/autoDispatch');
    const title = 'Confirm kiosk wording deployment timing for laptop camper policy';
    const note = colleagueAskNote('Sam', 'Arjun', title);
    expect(note).toContain('Arjun');
    expect(note).toContain('Sam');
    expect(note).toContain(title);
    expect(note).toMatch(/ONE short spoken sentence/i);
    expect(note).toMatch(/never the task title's wording/i);
    expect(note).toMatch(/no report phrases/i);
    expect(note).not.toMatch(/on your phone|accept|decline/i);
  });
});

describe('guestCardNote', () => {
  it('does not carry a task title and names the guest and the host', async () => {
    const { guestCardNote } = await import('../../src/host/autoDispatch');
    const note = guestCardNote('Sam', 'Josh');
    expect(note).toContain('Josh');
    expect(note).toContain('Sam');
    expect(note).toMatch(/follow-up/i);
    expect(note).toMatch(/own words/i);
    expect(note).not.toMatch(/task title:|\btitle\b.*"/i);
  });
});

describe('colleagueCue', () => {
  it('gives the model a note in Sam\'s own words', async () => {
    const { colleagueCue } = await import('../../src/host/autoDispatch');
    const cue = colleagueCue('Sam', 'Mei', 'Draft plain-language sign for laptop zone decision', {
      volunteered: false,
      assignedByGuest: false,
    });
    expect(cue.note).toContain('Mei');
    expect(cue.note).toContain('Draft plain-language sign for laptop zone decision');
    expect(cue.quietBecause).toBeUndefined();
  });

  it('stays quiet when the colleague already volunteered', async () => {
    const { colleagueCue } = await import('../../src/host/autoDispatch');
    expect(colleagueCue('Sam', 'Mei', 'Draft a sign', { volunteered: true, assignedByGuest: false }))
      .toEqual({ quietBecause: 'volunteered' });
  });

  it('stays quiet when the guest already asked the colleague', async () => {
    const { colleagueCue } = await import('../../src/host/autoDispatch');
    expect(colleagueCue('Sam', 'Mei', 'Draft a sign', { volunteered: false, assignedByGuest: true }))
      .toEqual({ quietBecause: 'was asked' });
  });
});

describe('shouldStillAskColleague', () => {
  const onCurrentAgenda = (title: string | undefined): boolean => title === 'Prep';

  it('keeps the request while the task is dispatched on the current topic', () => {
    expect(shouldStillAskColleague('DISPATCHED', 'Prep', onCurrentAgenda)).toBe(true);
    expect(shouldStillAskColleague(undefined, undefined, onCurrentAgenda)).toBe(true);
  });

  it('drops the request once the task is no longer dispatched', () => {
    expect(shouldStillAskColleague('SYNCED', 'Prep', onCurrentAgenda)).toBe(false);
    expect(shouldStillAskColleague('DISMISSED', undefined, onCurrentAgenda)).toBe(false);
  });

  it('drops the request once the meeting has moved to another topic', () => {
    expect(shouldStillAskColleague('DISPATCHED', 'Service', onCurrentAgenda)).toBe(false);
  });

  it('only checks the status when no topic is known', () => {
    expect(shouldStillAskColleague('DISPATCHED', undefined, () => false)).toBe(true);
  });
});

describe('a queued colleague request', () => {
  it('is dropped when the topic moves on, and the queue continues', async () => {
    const { createCueOrder } = await import('../../src/npc/cueOrder');
    const order = createCueOrder();
    const heard: string[] = [];
    order.cue((done) => {
      const keep = shouldStillAskColleague('DISPATCHED', 'Service', (topic) => topic === 'Prep');
      if (keep) heard.push('Sam asks');
      done(keep);
    });
    order.after((spoken) => heard.push(spoken ? 'colleague answers' : 'colleague claims silently'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toEqual(['colleague claims silently']);
  });
});

describe('dispatchLine', () => {
  it('starts with the usual line and then varies, always naming the person and the task', async () => {
    const { dispatchLine } = await import('../../src/host/autoDispatch');
    const lines = [0, 1, 2, 3].map((count) => dispatchLine('Ada', 'Fix the oven', count));
    expect(lines[0]).toBe("Ada, I've sent you a task: Fix the oven. Accept or decline it on your phone.");
    expect(new Set(lines.slice(0, 3)).size).toBe(3);
    expect(lines[3]).toBe(lines[0]);
    for (const line of lines) expect(line).toContain('Ada');
  });
});
