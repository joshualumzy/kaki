import { describe, expect, it } from 'vitest';
import { parseAmiArgs } from '../../src/host/eval/evalAmi';

describe('AMI eval arguments', () => {
  it('runs the working meetings by default and keeps the hold-out meetings apart', () => {
    expect(parseAmiArgs(['--ami']).meetings).toEqual(['ES2008a', 'ES2013b', 'IS1005c', 'IS1008d']);
    expect(parseAmiArgs(['--ami', '--holdout']).meetings).toEqual(['ES2016c', 'IS1006b']);
    expect(parseAmiArgs(['--ami', '--meeting', 'IS1006b', '--runs', '1'])).toEqual({ meetings: ['IS1006b'], runs: 1 });
    expect(() => parseAmiArgs(['--ami', '--holdout', '--meeting', 'ES2008a'])).toThrow(/either --holdout or --meeting/);
  });
});
