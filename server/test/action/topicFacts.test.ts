import { afterEach, describe, expect, it } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';
import { createTaskStore } from '../../src/tasks';
import { createFakeLlm } from '../../src/llm';
import { createGiteaModule } from '../../src/action/gitea';
import { createMattermostModule } from '../../src/action/mattermost';
import { createWikiModule } from '../../src/action/wiki';
import { createEmailModule } from '../../src/action/email';
import { waitFor } from '../helpers';

const scenario: Scenario = {
  id: 'test', organisation: 'Test', meetingTitle: 'Morning',
  roles: [
    { id: 'chef', label: 'Chef', card: { youAre: 'Chef', responsibility: 'Cook', facts: ['FOREIGN CARD FACT'] } },
    { id: 'cashier', label: 'Cashier', card: { youAre: 'Cashier', responsibility: 'Serve', facts: ['OTHER FOREIGN CARD FACT'] } },
  ],
  attendees: [
    { name: 'Ada', role: 'chef', zoomDisplayName: 'Ada' },
    { name: 'Bao', role: 'cashier', zoomDisplayName: 'Bao' },
  ],
  agenda: [
    { title: 'First', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'chef', seatFacts: { chef: 'FIRST CHEF FACT', cashier: 'FIRST CASHIER FACT' } },
    { title: 'Second', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'cashier', seatFacts: { chef: 'FOREIGN TOPIC FACT', cashier: 'ANOTHER FOREIGN TOPIC FACT' } },
  ],
};

const hub = {
  publish: (_event: KakiEvent) => {}, subscribe: () => () => {}, onCommand: () => {},
  clearRetained: () => {}, close: () => {},
};
const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

const cases = [
  ['Gitea', 'gitea_issue', (llm: ReturnType<typeof createFakeLlm>) => createGiteaModule({
    llm, gitea: { url: 'http://example.test', token: 'test', owner: 'test', repo: 'test' },
  })],
  ['Mattermost', 'mattermost_post', (llm: ReturnType<typeof createFakeLlm>) => createMattermostModule({
    llm, mattermost: { url: 'http://example.test', token: 'test', team: 'test', channel: 'test' },
  })],
  ['Wiki', 'wiki_page', (llm: ReturnType<typeof createFakeLlm>) => createWikiModule({
    llm, wiki: { url: 'http://example.test', email: 'test@example.test', password: 'test' },
  })],
  ['Email', 'email', (llm: ReturnType<typeof createFakeLlm>) => createEmailModule({
    llm, email: { smtpHost: '127.0.0.1', smtpPort: 1025, from: 'test@example.test', mailpitUrl: 'http://example.test' },
  })],
] as const;

describe.each(cases)('%s draft', (_name, actionKind, makeModule) => {
  it('only receives seat facts from the task topic', async () => {
    const llm = createFakeLlm(() => '{}');
    const tasks = createTaskStore({ hub, scenario });
    const stop = makeModule(llm).start({ hub, tasks, activeScenario: () => scenario, draftOnly: true });
    if (stop !== undefined) stops.push(stop);
    const task = tasks.suggest({ title: 'Record the decision', context: 'A call has been made.',
      suggestedAssignee: 'chef', actionKind, agendaItemTitle: 'First' });
    tasks.transition(task.id, 'DISPATCHED', { assignee: 'chef' });
    tasks.transition(task.id, 'CLAIMED', { mode: 'ACTION_AGENT' });
    await waitFor(() => llm.calls.length > 0 ? true : undefined, 'draft prompt');
    const prompt = llm.calls[0]!.map((message) => message.content).join('\n');
    expect(prompt).toContain('FIRST CHEF FACT');
    expect(prompt).not.toContain('FOREIGN TOPIC FACT');
    expect(prompt).not.toContain('ANOTHER FOREIGN TOPIC FACT');
    expect(prompt).not.toContain('FOREIGN CARD FACT');
    if (actionKind === 'email') expect(prompt).toContain('FIRST CASHIER FACT');
    else expect(prompt).not.toContain('FIRST CASHIER FACT');
  });
});
