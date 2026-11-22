import { describe, expect, it } from 'vitest';
import { mergeTurns, parseAbstractiveXml, parseMeetingsXml, parseWordsXml } from '../../src/host/eval/convertAmi';

const speakers = (agent: string): string =>
  agent === 'A' ? 'Project Manager' : agent === 'B' ? 'Marketing Expert' : agent;

describe('AMI word conversion', () => {
  it('orders words across speakers, joins punctuation and starts at the first word', () => {
    const first = [
      '<w starttime="10.0" endtime="10.2">Hello</w>',
      '<w starttime="10.2" endtime="10.2" punc="true">,</w>',
      '<w starttime="10.3" endtime="10.5">world</w>',
      '<w starttime="10.5" endtime="10.5" punc="true">.</w>',
      '<w starttime="20.0" endtime="20.2">Later</w>',
    ].join('');
    const second = [
      '<w starttime="5.0" endtime="5.2">Early</w>',
      '<w starttime="5.2" endtime="5.2" punc="true">?</w>',
      '<w starttime="11.0" endtime="11.2">Question</w>',
    ].join('');

    const words = [...parseWordsXml(first, 'A'), ...parseWordsXml(second, 'B')];

    expect(mergeTurns(words, speakers)).toEqual([
      { at: 0, speaker: 'Marketing Expert', text: 'Early?' },
      { at: 5, speaker: 'Project Manager', text: 'Hello, world.' },
      { at: 6, speaker: 'Marketing Expert', text: 'Question' },
      { at: 15, speaker: 'Project Manager', text: 'Later' },
    ]);
  });

  it('keeps a sentence whole when another speaker talks over it', () => {
    const speaking = parseWordsXml(
      '<w starttime="0" endtime="0.4">It&apos;s</w><w starttime="0.5" endtime="0.9">a</w><w starttime="1.0" endtime="1.4">whale</w>',
      'A',
    );
    const overlapping = parseWordsXml('<w starttime="0.45" endtime="0.6">Em</w>', 'B');

    expect(mergeTurns([...speaking, ...overlapping], speakers)).toEqual([
      { at: 0, speaker: 'Project Manager', text: "It's a whale" },
      { at: 0.45, speaker: 'Marketing Expert', text: 'Em' },
    ]);
  });

  it('splits a turn only after a pause longer than two seconds', () => {
    const within = parseWordsXml(
      '<w starttime="0" endtime="1">One</w><w starttime="3" endtime="3.5">two</w>',
      'A',
    );
    const beyond = parseWordsXml(
      '<w starttime="0" endtime="1">One</w><w starttime="3.01" endtime="3.5">two</w>',
      'A',
    );

    expect(mergeTurns(within, speakers)).toHaveLength(1);
    expect(mergeTurns(beyond, speakers)).toHaveLength(2);
  });

  it('decodes XML entities and ignores non-word elements', () => {
    const words = parseWordsXml(
      [
        '<vocalsound starttime="0" endtime="0.5" type="other"/>',
        '<disfmarker starttime="0.5" endtime="0.5"/>',
        '<w starttime="1" endtime="1.2">I&#39;m</w>',
        '<w starttime="1.2" endtime="1.4">ready</w>',
        '<gap starttime="1.4" endtime="1.4"/>',
      ].join(''),
      'A',
    );

    expect(mergeTurns(words, speakers)).toEqual([{ at: 0, speaker: 'Project Manager', text: "I'm ready" }]);
  });
});

describe('AMI gold extraction', () => {
  it('reads actions, decisions and problems from their sections', () => {
    const xml = [
      '<nite:root>',
      '<abstract><sentence>Ignored summary.</sentence></abstract>',
      '<actions>',
      '<sentence>First &amp; second</sentence>',
      '<sentence>  spaced\n text  </sentence>',
      '</actions>',
      '<decisions><sentence>One decision.</sentence></decisions>',
      '<problems></problems>',
      '</nite:root>',
    ].join('');

    expect(parseAbstractiveXml(xml)).toEqual({
      actions: ['First & second', 'spaced text'],
      decisions: ['One decision.'],
      problems: [],
    });
  });

  it('maps each meeting agent to its AMI role code', () => {
    const xml = [
      '<nite:root>',
      '<meeting observation="ES2008a">',
      '<speaker nxt_agent="A" role="PM"/>',
      '<speaker nxt_agent="B" role="ID"/>',
      '</meeting>',
      '<meeting observation="IS1005c">',
      '<speaker nxt_agent="A" role="ME"/>',
      '</meeting>',
      '</nite:root>',
    ].join('');

    const meetings = parseMeetingsXml(xml);

    expect([...(meetings.get('ES2008a') ?? [])]).toEqual([
      ['A', 'PM'],
      ['B', 'ID'],
    ]);
    expect(meetings.get('IS1005c')?.get('A')).toBe('ME');
  });
});
