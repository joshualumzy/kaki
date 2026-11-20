import { describe, expect, it } from 'vitest';
import {
  inviteCodeFromLink,
  judgeFollowUpTask,
  judgeMinutesRecipient,
  judgeSeatOptions,
  judgeTranscriptPresence,
  ownerCredentials,
  pageShowsArtifact,
  practiceBusyIsPlain,
  seatRefusalIsPlain,
} from './team-playtest-helpers';

describe('owner credentials', () => {
  it('needs nothing when sign-in is off', () => {
    expect(ownerCredentials({}, false)).toEqual({ ok: true });
  });

  it('names every missing variable without leaking a password', () => {
    const both = ownerCredentials({}, true);
    expect(both.ok).toBe(false);
    if (both.ok) throw new Error('expected a refusal');
    expect(both.missing).toEqual(['KAKI_PLAYTEST_OWNER_EMAIL', 'KAKI_PLAYTEST_OWNER_PASSWORD']);
    expect(both.message).toContain('KAKI_PLAYTEST_OWNER_EMAIL');
    expect(both.message).toContain('KAKI_PLAYTEST_OWNER_PASSWORD');

    const justPassword = ownerCredentials({ KAKI_PLAYTEST_OWNER_EMAIL: 'owner@example.test' }, true);
    expect(justPassword.ok).toBe(false);
    if (justPassword.ok) throw new Error('expected a refusal');
    expect(justPassword.missing).toEqual(['KAKI_PLAYTEST_OWNER_PASSWORD']);
  });

  it('returns the credentials when sign-in is on and both are set', () => {
    expect(ownerCredentials({
      KAKI_PLAYTEST_OWNER_EMAIL: ' owner@example.test ',
      KAKI_PLAYTEST_OWNER_PASSWORD: 'secret',
    }, true)).toEqual({ ok: true, email: 'owner@example.test', password: 'secret' });
  });
});

describe('invite link', () => {
  it('reads the code from an absolute or relative join link', () => {
    expect(inviteCodeFromLink('http://localhost:5173/join?code=ABCD')).toBe('ABCD');
    expect(inviteCodeFromLink('/join?code=WXYZ')).toBe('WXYZ');
    expect(inviteCodeFromLink('https://kaki.example/join?x=1&code=ab12')).toBe('ab12');
  });

  it('rejects links with no code or a different page', () => {
    expect(inviteCodeFromLink('/join')).toBeUndefined();
    expect(inviteCodeFromLink('/join?code=%20')).toBeUndefined();
    expect(inviteCodeFromLink('/meeting?code=ABCD')).toBeUndefined();
    expect(inviteCodeFromLink('not a url at all')).toBeUndefined();
  });
});

describe('transcript presence', () => {
  const lines = ['Owner line one', 'Ana line two', 'Ben line three'];

  it('passes when each expected line appears exactly once in every window', () => {
    const verdict = judgeTranscriptPresence(lines, {
      Owner: [...lines],
      Ana: [...lines].reverse(),
      Ben: [...lines],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.detail).toContain('exactly once');
  });

  it('reports a missing line and a repeated line by window', () => {
    const verdict = judgeTranscriptPresence(lines, {
      Owner: [...lines],
      Ana: ['Owner line one', 'Ana line two'],
      Ben: ['Owner line one', 'Ana line two', 'Ben line three', 'Ben line three'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain('Ana: "Ben line three" appeared 0 time(s)');
    expect(verdict.problems).toContain('Ben: "Ben line three" appeared 2 time(s)');
  });

  it('counts exact lines only, not a short line inside a longer one', () => {
    const verdict = judgeTranscriptPresence(['Ana'], { Owner: ['Ana line two'] });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual(['Owner: "Ana" appeared 0 time(s)']);
  });
});

describe('plain refusals', () => {
  it('accepts the seat refusal sentence and rejects technical text', () => {
    expect(seatRefusalIsPlain('That seat is taken. Pick another role.')).toBe(true);
    expect(seatRefusalIsPlain('409 Conflict')).toBe(false);
    expect(seatRefusalIsPlain('The meeting is full (3 people at most).')).toBe(false);
    expect(seatRefusalIsPlain('')).toBe(false);
  });

  it('accepts the practice refusal sentence and rejects technical text', () => {
    expect(practiceBusyIsPlain('A team meeting is in progress right now. Try practice again later.')).toBe(true);
    expect(practiceBusyIsPlain('HTTP 409')).toBe(false);
    expect(practiceBusyIsPlain('Could not join (HTTP 409).')).toBe(false);
    expect(practiceBusyIsPlain('')).toBe(false);
  });
});

describe('join seat options', () => {
  it('accepts exactly the person seats in any order', () => {
    expect(judgeSeatOptions([' Ben ', 'Owner', 'Ana'], ['Owner', 'Ana', 'Ben']).ok).toBe(true);
  });

  it('rejects an extra seat, a missing seat or a duplicate', () => {
    expect(judgeSeatOptions(['Owner', 'Ana', 'Ben', 'Sam'], ['Owner', 'Ana', 'Ben']).ok).toBe(false);
    expect(judgeSeatOptions(['Owner', 'Ana'], ['Owner', 'Ana', 'Ben']).ok).toBe(false);
    expect(judgeSeatOptions(['Owner', 'Ana', 'Ana'], ['Owner', 'Ana']).ok).toBe(false);
  });
});

describe('minutes recipient', () => {
  it('passes only for the owner seat', () => {
    expect(judgeMinutesRecipient({ assignee: 'role_1' }, 'role_1', ['role_2', 'role_3']).ok).toBe(true);
  });

  it('names a participant or another seat instead of the owner', () => {
    expect(judgeMinutesRecipient({ assignee: 'role_2' }, 'role_1', ['role_2', 'role_3'])).toEqual({
      ok: false,
      detail: "Minutes card went to a participant's seat role_2, not the owner role_1",
    });
    expect(judgeMinutesRecipient({ suggestedAssignee: 'producer' }, 'role_1', ['role_2']).detail)
      .toContain('not the owner role_1');
    expect(judgeMinutesRecipient(undefined, 'role_1', []).ok).toBe(false);
  });
});

describe('follow-up task outcome', () => {
  it('passes when a card was seen', () => {
    expect(judgeFollowUpTask(true, 'ok')).toMatchObject({ status: 'PASS' });
  });

  it('is NOT EXERCISED only when the notetaker has no LLM', () => {
    expect(judgeFollowUpTask(false, 'off')).toMatchObject({ status: 'NOT EXERCISED' });
    expect(judgeFollowUpTask(false, 'off').detail).toContain('notetakerStatus off');
  });

  it('fails a configured notetaker that stayed silent or failed', () => {
    expect(judgeFollowUpTask(false, 'waiting').status).toBe('FAIL');
    expect(judgeFollowUpTask(false, 'ok').status).toBe('FAIL');
    expect(judgeFollowUpTask(false, 'stale').status).toBe('FAIL');
    expect(judgeFollowUpTask(false, undefined).status).toBe('FAIL');
  });
});

describe('published artifact visibility', () => {
  it('recognises the URL or the minutes link text', () => {
    expect(pageShowsArtifact('', ['http://host:8081/en/meetings/today'], 'http://host:8081/en/meetings/today')).toBe(true);
    expect(pageShowsArtifact('Open meeting minutes in Wiki ↗', [], 'http://host:8081/en/meetings/today')).toBe(true);
    expect(pageShowsArtifact('nothing here', ['/somewhere-else'], 'http://host:8081/en/meetings/today')).toBe(false);
    expect(pageShowsArtifact('nothing here', ['', '   '], 'http://host:8081/en/meetings/today')).toBe(false);
    expect(pageShowsArtifact('', [], '')).toBe(false);
  });
});
