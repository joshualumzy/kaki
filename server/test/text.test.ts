import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '../src/text';

describe('escapeRegExp', () => {
  it('escapes every regular-expression metacharacter', () => {
    const raw = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(`^${escapeRegExp(raw)}$`).test(raw)).toBe(true);
  });

  it('leaves text without metacharacters alone', () => {
    expect(escapeRegExp('Arjun (Lead)')).toBe('Arjun \\(Lead\\)');
  });
});
