import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, cleanSpoken, TurnParser, type Utterance } from '../../src/npc/director';
import { testScenario } from '../fixtures/scenario';

const npcScenario = {
  ...testScenario,
  npcs: [
    { attendee: 'Ada', voice: 'v1', personality: 'Calm chef', agenda: 'Cut waste', concerns: ['Rising costs', 'Late deliveries'], knows: ['Oven is broken'], soundsLike: ['Adah', 'Ayda'] },
    { attendee: 'Bao', voice: 'v2', personality: 'Chatty cashier', agenda: 'Fix queues', concerns: ['Long lines'] },
  ],
};

/** Feed a reply in the given pieces, as a model would stream it, and collect every utterance. */
function parse(pieces: string[], names = ['Ada', 'Bao']): Utterance[] {
  const parser = new TurnParser(names);
  return [...pieces.flatMap((piece) => parser.push(piece)), ...parser.flush()];
}

describe('TurnParser', () => {
  it('yields one utterance per sentence, tagged with the speaker', () => {
    expect(parse(['Ada: Hello there. How are you?\nBao: Fine, thanks.'])).toEqual([
      { speaker: 'Ada', text: 'Hello there.' },
      { speaker: 'Ada', text: 'How are you?' },
      { speaker: 'Bao', text: 'Fine, thanks.' },
    ]);
  });

  it('gives the same result however the stream is cut into pieces', () => {
    const reply = 'Ada: I hear you, but that is risky. Let us talk.\nBao: Agreed! Option 3.5 is cheaper.';
    const whole = parse([reply]);
    expect(parse(reply.split(''))).toEqual(whole);
    expect(parse(reply.match(/.{1,7}/gs) ?? [])).toEqual(whole);
    expect(whole.map((u) => u.text)).toEqual([
      'I hear you, but that is risky.',
      'Let us talk.',
      'Agreed!',
      'Option 3.5 is cheaper.',
    ]);
  });

  it('emits a finished sentence before the rest of the reply has arrived', () => {
    const parser = new TurnParser(['Ada', 'Bao']);
    expect(parser.push('Ada: First sentence. Seco')).toEqual([{ speaker: 'Ada', text: 'First sentence.' }]);
    expect(parser.push('nd one.')).toEqual([]);
    expect(parser.flush()).toEqual([{ speaker: 'Ada', text: 'Second one.' }]);
  });

  it('switches speaker when a name follows a finished sentence on the same line', () => {
    expect(parse(['Ada: Sounds fair. Bao: I disagree.'])).toEqual([
      { speaker: 'Ada', text: 'Sounds fair.' },
      { speaker: 'Bao', text: 'I disagree.' },
    ]);
  });

  it('does not treat a name with a colon inside a sentence as a new turn', () => {
    expect(parse(['Ada: Ask Bao: he knows the menu.'])).toEqual([
      { speaker: 'Ada', text: 'Ask Bao: he knows the menu.' },
    ]);
  });

  it('matches names case-insensitively and returns the canonical spelling', () => {
    expect(parse(['ADA: Morning.'])).toEqual([{ speaker: 'Ada', text: 'Morning.' }]);
  });

  it('lets the first character say a reply that forgot its name tag', () => {
    expect(parse(['Sure, go ahead.'])).toEqual([{ speaker: 'Ada', text: 'Sure, go ahead.' }]);
  });

  it('says nothing for NONE, however it is streamed', () => {
    expect(parse(['NO', 'NE'])).toEqual([]);
    expect(parse(['NONE\n'])).toEqual([]);
  });

  it('removes markdown, emoji and stage directions before they reach the voice', () => {
    expect(parse(['Ada: *smiles* **Great** idea 🎉 (laughs) team!'])).toEqual([
      { speaker: 'Ada', text: 'Great idea team!' },
    ]);
    expect(cleanSpoken('  a   b  ')).toBe('a b');
  });

  it('drops turns that contain nothing to say', () => {
    expect(parse(['Ada: ...\nBao: Right.'])).toEqual([{ speaker: 'Bao', text: 'Right.' }]);
  });
});

describe('buildSystemPrompt', () => {
  it('tells the model what the meeting is about, and which words are probably a mis-heard name', () => {
    const prompt = buildSystemPrompt({ ...npcScenario, situation: 'The oven broke an hour before lunch.' });
    expect(prompt).toContain('The situation: The oven broke an hour before lunch.');
    expect(prompt).toContain('heard instead of the name: Ada: Adah, Ayda');
    expect(buildSystemPrompt(npcScenario)).not.toContain('The situation:');
  });

  it('asks for direct answers and a warm, human tone, without naming anything from one scenario', () => {
    const prompt = buildSystemPrompt(npcScenario);
    expect(prompt).toContain('answer it directly and concretely first');
    expect(prompt).toContain('Notice how the person seems');
    expect(prompt).toContain('Ada: Yeah, I hear you.');
    expect(prompt).not.toMatch(/crash|Arjun|Hawker/);
  });

  it('describes every character from the scenario, not from code', () => {
    const prompt = buildSystemPrompt(npcScenario);
    for (const text of ['Ada (Chef)', 'Calm chef', 'Cut waste', 'Rising costs | Late deliveries', 'Oven is broken', 'Bao (Cashier)', 'Long lines']) {
      expect(prompt).toContain(text);
    }
    expect(prompt).toContain('using exactly these names: Ada, Bao');
    expect(prompt).toContain('Prep (5 min)');
  });

  it('puts each character\'s speech style, hidden goal, part and tensions in the prompt', () => {
    const [ada, bao] = npcScenario.npcs ?? [];
    const prompt = buildSystemPrompt({
      ...npcScenario,
      npcs: [
        { ...ada!, role: 'host', speechStyle: 'Brisk and dry', hiddenGoal: 'Finish early', tensions: [{ with: 'Bao', about: 'the menu' }] },
        { ...bao!, role: 'observer' },
      ],
    });
    for (const text of ['Part: the host', 'Sounds like: Brisk and dry', 'Quietly wants (does not say outright): Finish early', 'Disagrees with: Bao about the menu', 'Part: quiet observer', 'answer the other directly']) {
      expect(prompt).toContain(text);
    }
    expect(buildSystemPrompt(npcScenario)).not.toMatch(/Sounds like:|Disagrees with:|Part:/);
  });

  it('addresses the person by name and role once they have joined', () => {
    expect(buildSystemPrompt(npcScenario)).toContain('about to join');
    expect(buildSystemPrompt(npcScenario, { name: 'Josh', role: 'Producer' })).toContain('Josh, the Producer');
  });
});
