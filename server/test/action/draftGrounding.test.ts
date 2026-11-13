import { describe, expect, it } from 'vitest';
import { clockTimes, draftSourceText, unsupportedDraftDetails } from '../../src/action/draftGrounding';

describe('draft grounding', () => {
  it('allows a detail recorded in meeting memory and rejects an absent detail', () => {
    const task = { title: 'Send the plan', context: 'Tell the team the decision.' };
    const draft = 'The supplier will arrive at 9 AM.';
    expect(unsupportedDraftDetails(draft, draftSourceText(task, [], [
      { kind: 'invented', item: 'Prep', text: 'The supplier can arrive at 9 AM.' },
    ]))).toEqual([]);
    expect(unsupportedDraftDetails(draft, draftSourceText(task))).toContain('"9 AM" is not in the task context');
  });
  it('reads explicit times and infers the AM/PM shared by a range', () => {
    expect(clockTimes('The booth rule runs from 8 to 10:30 AM.')).toEqual([
      { hour: 10, minute: 30, meridiem: 'am' },
      { hour: 8, minute: 0, meridiem: 'am' },
    ]);
  });

  it('accepts a draft time that the task states, including the shared AM/PM of a range', () => {
    expect(
      unsupportedDraftDetails(
        'The booth rule runs from 8 AM to 10:30 AM every morning.',
        'The booth rule runs from 8 to 10:30 AM every morning.',
      ),
    ).toEqual([]);
  });

  it('rejects an invented AM/PM when the task gives no meridiem', () => {
    expect(
      unsupportedDraftDetails(
        'The booth rule runs from 8 PM to 10:30 PM every morning.',
        'The booth rule runs from 8 to 10:30 every morning.',
      ),
    ).toEqual([
      '"8 PM" is not in the task context',
      '"10:30 PM" is not in the task context',
    ]);
  });

  it('rejects a time that is not in the task at all', () => {
    expect(unsupportedDraftDetails('The review starts at 9 AM.', 'Book the review room.')).toEqual([
      '"9 AM" is not in the task context',
    ]);
  });

  it('rejects a claim that the work is already done when the task only asks for it', () => {
    expect(
      unsupportedDraftDetails('The cash box decision has been posted in the team channel.', 'Post the cash box decision in the team channel today.'),
    ).toEqual(['"has been posted" says the work is already done, but the task does not']);
  });

  it('allows a completion claim the task itself states', () => {
    expect(unsupportedDraftDetails('The cash box has been moved.', 'The cash box has been moved.')).toEqual([]);
  });

  it('rejects an invented immediate start', () => {
    expect(unsupportedDraftDetails('The rule applies effective immediately.', 'The rule applies from Monday.')).toEqual([
      '"effective immediately" adds a start date the task does not give',
    ]);
  });
});
