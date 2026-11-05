import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCueOrder } from '../../src/npc/cueOrder';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createCueOrder', () => {
  it('runs an answer at once when there is no cue', async () => {
    const order = createCueOrder();
    const run = vi.fn();
    order.after(run);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('holds the answer until the cue has been said', async () => {
    const order = createCueOrder();
    let done = (): void => undefined;
    order.cue((finished) => {
      done = finished;
    });
    const run = vi.fn();
    order.after(run);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    done();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('lets the answer through when the cue never reports back', async () => {
    const order = createCueOrder(1_000);
    order.cue(() => undefined);
    const run = vi.fn();
    order.after(run);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('only waits for the latest cue', async () => {
    const order = createCueOrder();
    const dones: Array<() => void> = [];
    order.cue((done) => dones.push(done));
    order.cue((done) => dones.push(done));
    const run = vi.fn();
    order.after(run);
    dones[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    dones[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
