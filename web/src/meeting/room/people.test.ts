import { describe, expect, it } from 'vitest';
import { distinctDisplayNames, peopleNotInRoom } from './people';

const person = (name: string, seat: string) => ({ name: name.toLowerCase(), displayName: name, seat, photoUrl: null });

describe('distinctDisplayNames', () => {
  it('numbers a second person with the same name', () => {
    const shown = distinctDisplayNames([person('Sam', 'a'), person('Ann', 'b'), person('sam', 'c')]);
    expect([shown.get('a'), shown.get('b'), shown.get('c')]).toEqual(['Sam', 'Ann', 'sam (2)']);
  });
});

describe('peopleNotInRoom', () => {
  it('lists only people LiveKit does not have yet', () => {
    const missing = peopleNotInRoom(
      [person('Sam', 'a'), person('Ann', 'b'), person('Bo', 'c')],
      [{ identity: 'x1', metadata: 'a' }, { identity: 'ann' }],
    );
    expect(missing.map((p) => p.seat)).toEqual(['c']);
  });
});
