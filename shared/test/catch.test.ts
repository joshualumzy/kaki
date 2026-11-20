import { describe, expect, it } from 'vitest';
import { catchPosition } from '../src/catch';

describe('catchPosition', () => {
  it('reads an agenda item and trade-off from a catch id', () => {
    expect(catchPosition('2:catch:1')).toEqual({ agendaIndex: 2, tradeOffIndex: 1 });
  });

  it('rejects anything that is not a catch id', () => {
    expect(catchPosition(undefined)).toBeUndefined();
    expect(catchPosition('2:fact:1')).toBeUndefined();
    expect(catchPosition('2:catch')).toBeUndefined();
    expect(catchPosition('two:catch:1')).toBeUndefined();
    expect(catchPosition('2:catch:one')).toBeUndefined();
  });
});
