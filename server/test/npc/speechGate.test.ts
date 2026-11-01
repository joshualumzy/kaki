import { describe, expect, it } from 'vitest';
import { SpeechGate } from '../../src/npc/speechGate';

function setup() {
  let time = 100_000;
  const gate = new SpeechGate({ now: () => time });
  return { gate, advance: (ms: number) => void (time += ms) };
}

describe('SpeechGate', () => {
  it('accepts anything while the AI has been quiet for a while', () => {
    const { gate } = setup();
    expect(gate.check('hello there')).toEqual({ ok: true });
  });

  it('rejects the AI echoing back, even when the voice check would pass', () => {
    const { gate } = setup();
    gate.aiSaid('The game crashes after ten customers in a row.');
    gate.setHumanTalking(true);
    expect(gate.check('the game crashes after ten customers in a row')).toEqual({ ok: false, reason: 'echo' });
    expect(gate.check('Game crashes after ten customers')).toEqual({ ok: false, reason: 'echo' });
  });

  it('does not mistake a short reply for echo', () => {
    const { gate } = setup();
    gate.aiSaid('Do you want to delay the launch or disable the store?');
    expect(gate.check('the store')).toEqual({ ok: true });
    expect(gate.check('disable the store')).toEqual({ ok: true });
  });

  it('does not call a long, different answer echo just because it shares a few words', () => {
    const { gate } = setup();
    gate.aiSaid('Do you want to delay the launch or disable the store?');
    expect(gate.check('I think we should delay the launch by a week and fix it properly')).toEqual({ ok: true });
  });

  it('while the AI talks, needs speech on the human microphone behind the text', () => {
    const { gate, advance } = setup();
    gate.setAiAudible(true);
    expect(gate.check('what about the budget')).toEqual({ ok: false, reason: 'no-voice' });

    gate.setHumanTalking(true);
    expect(gate.check('what about the budget')).toEqual({ ok: true });

    gate.setHumanTalking(false);
    advance(1000);
    expect(gate.check('what about the budget')).toEqual({ ok: true });
  });

  it('does not let the previous sentence vouch for text heard during the AI\'s next answer', () => {
    const { gate, advance } = setup();
    gate.setHumanTalking(true);
    gate.setHumanTalking(false);
    advance(900);
    gate.setAiAudible(true); // the AI answers: a new stretch of talking begins after the person spoke
    advance(500);
    expect(gate.check('what about the budget')).toEqual({ ok: false, reason: 'no-voice' });

    // The AI pausing between sentences does not start a new stretch, and speaking over it counts.
    gate.setAiAudible(false);
    gate.setAiAudible(true);
    gate.setHumanTalking(true);
    gate.setHumanTalking(false);
    expect(gate.check('what about the budget')).toEqual({ ok: true });
  });

  it('keeps the voice requirement for a moment after the AI stops, since recognition lags', () => {
    const { gate, advance } = setup();
    gate.setAiAudible(true);
    gate.setAiAudible(false);
    advance(1000);
    expect(gate.check('late echo of something')).toEqual({ ok: false, reason: 'no-voice' });
    advance(2000);
    expect(gate.check('a fresh remark')).toEqual({ ok: true });
  });

  it('forgets old AI sentences', () => {
    const { gate, advance } = setup();
    gate.aiSaid('We need a decision on the launch today please.');
    advance(30_000);
    expect(gate.check('we need a decision on the launch today please')).toEqual({ ok: true });
  });
});
