import { describe, expect, it } from 'vitest';
import type { AgendaItem } from '@kaki/shared';
import { createAgendaClock } from '../../src/host/clock';

const agenda: AgendaItem[] = [
  { title: 'Prep', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'chef' },
  { title: 'Till', minutes: 2, canWait: false, deadline: 'before doors open at 8', ownerRole: 'cashier' },
];

function fakeTime(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(seconds: number) {
      current += seconds * 1000;
    },
  };
}

describe('agenda clock', () => {
  it('stands still until started, then counts meeting and item time', () => {
    const time = fakeTime();
    const clock = createAgendaClock({ agenda, now: time.now });

    time.advance(30);
    expect(clock.snapshot()).toMatchObject({ started: false, itemElapsedSeconds: 0, overrun: false });

    clock.start();
    time.advance(90);
    expect(clock.snapshot()).toMatchObject({
      started: true,
      agendaIndex: 0,
      itemElapsedSeconds: 90,
      meetingElapsedSeconds: 90,
    });
  });

  it('restarts item time on advance and only ever moves forward', () => {
    const time = fakeTime();
    const clock = createAgendaClock({ agenda, now: time.now });
    clock.start();
    time.advance(200);

    clock.advanceTo(1);
    time.advance(10);
    expect(clock.snapshot()).toMatchObject({ agendaIndex: 1, itemElapsedSeconds: 10, meetingElapsedSeconds: 210 });

    clock.advanceTo(0);
    clock.advanceTo(5);
    clock.advanceTo(1.5);
    expect(clock.snapshot().agendaIndex).toBe(1);
  });

  it('signals overrun exactly once per item, when its minutes run out', () => {
    const time = fakeTime();
    const clock = createAgendaClock({ agenda, now: time.now });
    const overruns: number[] = [];
    clock.onOverrun((index) => overruns.push(index));
    clock.start();

    time.advance(299);
    clock.tick();
    expect(overruns).toEqual([]);

    time.advance(1);
    clock.tick();
    clock.tick();
    expect(clock.snapshot().overrun).toBe(true);
    expect(overruns).toEqual([0]);

    clock.advanceTo(1);
    expect(clock.snapshot().overrun).toBe(false);
    time.advance(120);
    clock.tick();
    expect(overruns).toEqual([0, 1]);
  });

  it('freezes time and stops signalling once the meeting ends', () => {
    const time = fakeTime();
    const clock = createAgendaClock({ agenda, now: time.now });
    const overruns: number[] = [];
    clock.onOverrun((index) => overruns.push(index));
    clock.end();
    expect(clock.snapshot().ended).toBe(false);

    clock.start();
    time.advance(100);
    clock.end();
    time.advance(1_000);
    clock.tick();
    clock.advanceTo(1);

    expect(clock.snapshot()).toMatchObject({ ended: true, agendaIndex: 0, meetingElapsedSeconds: 100 });
    expect(overruns).toEqual([]);
  });

  it('runs meeting time faster for a sped-up replay', () => {
    const time = fakeTime();
    const clock = createAgendaClock({ agenda, now: time.now, speed: 10 });
    clock.start();

    time.advance(30);
    expect(clock.snapshot()).toMatchObject({ itemElapsedSeconds: 300, overrun: true });
    expect(() => createAgendaClock({ agenda, speed: 0 })).toThrow(/positive/);
  });

  it('reset returns to an unstarted meeting on item 0 with overruns armed again', () => {
    const time = fakeTime();
    const clock = createAgendaClock({ agenda, now: time.now });
    let overruns = 0;
    clock.onOverrun(() => (overruns += 1));
    clock.start();
    clock.advanceTo(1);
    time.advance(200);
    clock.tick();
    clock.end();
    expect(overruns).toBe(1);

    clock.reset();
    expect(clock.snapshot()).toMatchObject({ started: false, ended: false, agendaIndex: 0, meetingElapsedSeconds: 0 });

    clock.start();
    clock.advanceTo(1);
    time.advance(200);
    clock.tick();
    expect(overruns).toBe(2);
  });

  it('freezes elapsed time and suppresses overruns while paused, then resumes from the exact second', () => {
    const time = fakeTime();
    const clock = createAgendaClock({ agenda, now: time.now });
    const overruns: number[] = [];
    clock.onOverrun((index) => overruns.push(index));

    clock.start();
    time.advance(150);
    clock.pause();
    expect(clock.snapshot()).toMatchObject({ paused: true, itemElapsedSeconds: 150, meetingElapsedSeconds: 150 });

    time.advance(500);
    clock.tick();
    expect(clock.snapshot()).toMatchObject({ paused: true, itemElapsedSeconds: 150, meetingElapsedSeconds: 150, overrun: false });
    expect(overruns).toEqual([]);

    clock.resume();
    expect(clock.snapshot()).toMatchObject({ paused: false, itemElapsedSeconds: 150, meetingElapsedSeconds: 150 });
    time.advance(40);
    expect(clock.snapshot()).toMatchObject({ paused: false, itemElapsedSeconds: 190, meetingElapsedSeconds: 190 });
  });
});
