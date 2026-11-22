import { describe, expect, it } from 'vitest';
import { actionFooter, formatMeetingTime, withActionFooter } from '../../src/action/footer';

describe('action footer', () => {
  it('formats meeting time as MM:SS under an hour', () => {
    expect(formatMeetingTime(930)).toBe('15:30');
    expect(formatMeetingTime(5)).toBe('00:05');
    expect(formatMeetingTime(0)).toBe('00:00');
  });

  it('formats meeting time as H:MM:SS past an hour', () => {
    expect(formatMeetingTime(3905)).toBe('1:05:05');
  });

  it('says who the card is for and which meeting approved it', () => {
    expect(actionFooter({ sourceSeconds: 930 }, 'Raffles Place Flagship Opening Day', 'Ada')).toBe(
      'Posted by Kaki for Ada, approved in Raffles Place Flagship Opening Day.',
    );
  });

  it('says the same whether or not the card has a source time', () => {
    expect(actionFooter({}, 'Raffles Place Flagship Opening Day', 'Ada')).toBe(
      'Posted by Kaki for Ada, approved in Raffles Place Flagship Opening Day.',
    );
  });

  it('appends the footer as the last line', () => {
    const body = withActionFooter('Fix the oven.\n', { sourceSeconds: 60 }, 'Lunch service readiness', 'Ada');
    expect(body).toBe('Fix the oven.\n\nPosted by Kaki for Ada, approved in Lunch service readiness.');
  });
});
