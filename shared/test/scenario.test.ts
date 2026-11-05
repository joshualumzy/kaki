import { describe, expect, it } from 'vitest';
import { isRoleIn, parseScenario, roleForZoomName, roleLabel } from '../src/scenario';
import { testScenario } from './fixtures';

function cloneScenario(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(testScenario)) as Record<string, unknown>;
}

describe('parseScenario', () => {
  it('accepts a valid scenario', () => {
    expect(parseScenario(cloneScenario())).toEqual(testScenario);
  });

  it('rejects a value that is not an object', () => {
    expect(() => parseScenario(null)).toThrow(/expected a JSON object/);
    expect(() => parseScenario('scenario')).toThrow(/expected a JSON object/);
  });

  it('rejects empty required text', () => {
    const scenario = cloneScenario();
    scenario.organisation = '  ';
    scenario.meetingTitle = '';
    expect(() => parseScenario(scenario)).toThrow(/organisation must be a non-empty string/);
    expect(() => parseScenario(scenario)).toThrow(/meetingTitle must be a non-empty string/);
  });

  it('accepts AI attendees that play scenario attendees', () => {
    const scenario = cloneScenario();
    scenario.npcs = [
      { attendee: 'Ada', voice: 'en-US-AriaNeural', personality: 'Calm', agenda: 'Serve lunch', concerns: ['Waste'] },
    ];
    expect(parseScenario(scenario).npcs).toHaveLength(1);
  });

  it('accepts a situation and mishearing hints, and rejects empty ones', () => {
    const scenario = cloneScenario();
    scenario.situation = 'Lunch service starts in an hour.';
    scenario.npcs = [
      { attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'], soundsLike: ['Adah'] },
    ];
    expect(parseScenario(scenario).situation).toBe('Lunch service starts in an hour.');

    scenario.situation = '  ';
    (scenario.npcs as Array<Record<string, unknown>>)[0]!.soundsLike = [''];
    expect(() => parseScenario(scenario)).toThrow(/situation must be a non-empty string/);
    expect(() => parseScenario(scenario)).toThrow(/soundsLike must be an array of non-empty strings/);
  });

  it('accepts a role, speech style, hidden goal and tensions, and rejects bad ones', () => {
    const scenario = cloneScenario();
    const npc = { attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] };
    scenario.npcs = [
      { ...npc, role: 'host', speechStyle: 'Brisk', hiddenGoal: 'Finish early', tensions: [{ with: 'Bao', about: 'the menu' }] },
    ];
    expect(parseScenario(scenario).npcs?.[0]?.tensions).toEqual([{ with: 'Bao', about: 'the menu' }]);

    scenario.npcs = [
      {
        ...npc,
        role: 'boss',
        speechStyle: ' ',
        tensions: [{ with: 'Ada', about: 'x' }, { with: 'Nobody', about: 'x' }, { with: 'Bao', about: '' }],
      } as never,
    ];
    for (const message of [/role must be one of/, /speechStyle must be a non-empty string/, /cannot be the character themselves/, /"Nobody" is not one of the attendees/, /tensions\[2\] must have/]) {
      expect(() => parseScenario(scenario)).toThrow(message);
    }
  });

  it('rejects AI attendees that are unknown, duplicated or incomplete', () => {
    const scenario = cloneScenario();
    const npc = { attendee: 'Ada', voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] };
    scenario.npcs = [npc, npc, { ...npc, attendee: 'Nobody' }, { ...npc, attendee: 'Bao', concerns: [''], voice: ' ' }];
    expect(() => parseScenario(scenario)).toThrow(/npcs\[1\]\.attendee "Ada" is duplicated/);
    expect(() => parseScenario(scenario)).toThrow(/npcs\[2\]\.attendee "Nobody" is not one of the attendees/);
    expect(() => parseScenario(scenario)).toThrow(/npcs\[3\]\.voice must be a non-empty string/);
    expect(() => parseScenario(scenario)).toThrow(/npcs\[3\]\.concerns must be an array of non-empty strings/);
  });

  it('rejects an empty role list', () => {
    const scenario = cloneScenario();
    scenario.roles = [];
    expect(() => parseScenario(scenario)).toThrow(/at least one role/);
  });

  it('rejects a duplicate role id', () => {
    const scenario = cloneScenario();
    scenario.roles = [
      { id: 'chef', label: 'Chef' },
      { id: 'chef', label: 'Second Chef' },
    ];
    expect(() => parseScenario(scenario)).toThrow(/duplicated/);
  });

  it('rejects the reserved screen role', () => {
    const scenario = cloneScenario();
    scenario.roles = [{ id: 'screen', label: 'Screen' }];
    expect(() => parseScenario(scenario)).toThrow(/reserved/);
  });

  it('rejects role ids that do not match the pattern', () => {
    const scenario = cloneScenario();
    scenario.roles = [{ id: 'Head Chef', label: 'Head Chef' }];
    expect(() => parseScenario(scenario)).toThrow(/must match/);
  });

  it('rejects an attendee with an unknown role', () => {
    const scenario = cloneScenario();
    scenario.attendees = [{ name: 'Ada', role: 'waiter', zoomDisplayName: 'Ada' }];
    expect(() => parseScenario(scenario)).toThrow(/not a known role/);
  });

  it('accepts an optional decision on an agenda item and rejects an empty one', () => {
    const scenario = cloneScenario();
    scenario.agenda = [{ title: 'Prep', minutes: 5, ownerRole: 'chef', decision: 'do we hold the menu?' }];
    expect(parseScenario(scenario).agenda[0]?.decision).toBe('do we hold the menu?');
    scenario.agenda = [{ title: 'Prep', minutes: 5, ownerRole: 'chef', decision: ' ' }];
    expect(() => parseScenario(scenario)).toThrow(/decision must be a non-empty string/);
  });

  it('accepts contested items and a glossary, and rejects bad ones', () => {
    const scenario = cloneScenario();
    scenario.agenda = [{ title: 'Prep', minutes: 5, ownerRole: 'chef', contested: true }];
    scenario.glossary = { oven: 'the big hot box' };
    expect(parseScenario(scenario).glossary?.oven).toBe('the big hot box');
    scenario.glossary = { oven: ' ' };
    expect(() => parseScenario(scenario)).toThrow(/glossary must map/);
    scenario.glossary = undefined;
    scenario.agenda = [{ title: 'Prep', minutes: 5, ownerRole: 'chef', contested: 'yes' as never }];
    expect(() => parseScenario(scenario)).toThrow(/contested must be true or false/);
  });

  it('rejects an agenda item with an unknown owner role', () => {
    const scenario = cloneScenario();
    scenario.agenda = [{ title: 'Prep', minutes: 5, ownerRole: 'waiter' }];
    expect(() => parseScenario(scenario)).toThrow(/ownerRole "waiter" is not a known role/);
  });

  it('rejects zero minutes and an empty agenda', () => {
    const zero = cloneScenario();
    zero.agenda = [{ title: 'Prep', minutes: 0, ownerRole: 'chef' }];
    expect(() => parseScenario(zero)).toThrow(/greater than zero/);

    const empty = cloneScenario();
    empty.agenda = [];
    expect(() => parseScenario(empty)).toThrow(/at least one agenda item/);
  });

  it('reports every problem in one message', () => {
    const scenario = cloneScenario();
    scenario.id = '';
    scenario.agenda = [{ title: 'Prep', minutes: -5, ownerRole: 'chef' }];
    scenario.attendees = [{ name: '', role: 'waiter', zoomDisplayName: 'Ada' }];

    expect(() => parseScenario(scenario)).toThrow(
      /id must be a non-empty string[\s\S]*attendees\[0\]\.name[\s\S]*attendees\[0\]\.role "waiter"[\s\S]*minutes/,
    );
  });
});

describe('scenario helpers', () => {
  it('checks roles against the scenario', () => {
    expect(isRoleIn(testScenario, 'chef')).toBe(true);
    expect(isRoleIn(testScenario, 'waiter')).toBe(false);
    expect(isRoleIn(testScenario, 'screen')).toBe(false);
    expect(isRoleIn(testScenario, null)).toBe(false);
  });

  it('returns labels and throws for unknown roles', () => {
    expect(roleLabel(testScenario, 'cashier')).toBe('Cashier');
    expect(() => roleLabel(testScenario, 'waiter')).toThrow(/Unknown role/);
  });

  it('maps Zoom display names to roles', () => {
    expect(roleForZoomName(testScenario, '  ADA (chef) ')).toBe('chef');
    expect(roleForZoomName(testScenario, 'Nobody')).toBeUndefined();
  });
});
