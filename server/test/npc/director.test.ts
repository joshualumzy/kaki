import { describe, expect, it } from 'vitest';
import { addressedCharacter, buildSystemPrompt, cleanSpoken, findHandover, TurnParser, type Utterance } from '../../src/npc/director';
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

  it('gives a reply that forgot its name tag to the fallback speaker, when there is one', () => {
    const parser = new TurnParser(['Ada', 'Bao'], 'bao');
    expect([...parser.push('Sure, go ahead. '), ...parser.flush()]).toEqual([{ speaker: 'Bao', text: 'Sure, go ahead.' }]);
  });

  it('lets the first character say a reply that forgot its name tag', () => {
    expect(parse(['Sure, go ahead.'])).toEqual([{ speaker: 'Ada', text: 'Sure, go ahead.' }]);
  });

  it('says nothing for NONE, however it is streamed', () => {
    expect(parse(['NO', 'NE'])).toEqual([]);
    expect(parse(['NONE\n'])).toEqual([]);
  });

  it('removes markdown, emoji and stage directions before they reach the voice, and turns spaced dashes into comma pauses', () => {
    expect(parse(['Ada: *smiles* **Great** idea 🎉 (laughs) team!'])).toEqual([
      { speaker: 'Ada', text: 'Great idea team!' },
    ]);
    expect(cleanSpoken('  a   b  ')).toBe('a b');
    expect(cleanSpoken('@MakanWithZack butter slice')).toBe('MakanWithZack butter slice');
    expect(cleanSpoken('Sounds good to me - I will work on it — right away.')).toBe(
      'Sounds good to me, I will work on it, right away.',
    );
  });

  it('drops turns that contain nothing to say', () => {
    expect(parse(['Ada: ...\nBao: Right.'])).toEqual([{ speaker: 'Bao', text: 'Right.' }]);
  });
});

describe('addressedCharacter', () => {
  const cast = [
    { attendee: 'Sam', voice: 'v', personality: 'p', agenda: 'a', concerns: [], soundsLike: ['Some'] },
    { attendee: 'Arjun', voice: 'v', personality: 'p', agenda: 'a', concerns: [], soundsLike: ['Archer'] },
  ];

  it('finds the one character addressed by name at the start, or explicitly', () => {
    expect(addressedCharacter('Sam. Sam, I have a question.', cast)).toBe('Sam');
    expect(addressedCharacter('Hey Arjun, how is the build?', cast)).toBe('Arjun');
    expect(addressedCharacter("I'm addressing this to Sam.", cast)).toBe('Sam');
    expect(addressedCharacter('I have a question for Arjun', cast)).toBe('Arjun');
    expect(addressedCharacter('Archer, can you hear me', cast)).toBe('Arjun');
  });

  it('leaves it to the model when nobody, or several, are addressed, or a name is just mentioned', () => {
    expect(addressedCharacter('Hello everyone.', cast)).toBeUndefined();
    expect(addressedCharacter('Sam and Arjun, what do you think?', cast)).toBeUndefined();
    expect(addressedCharacter('I told Sam about the crash yesterday', cast)).toBeUndefined();
    expect(addressedCharacter('Samantha went home', cast)).toBeUndefined();
  });
});

describe('buildSystemPrompt', () => {
  it('has the characters follow the person when that person is the host', () => {
    const scenario = {
      ...npcScenario,
      roles: [...npcScenario.roles, { id: 'manager', label: 'Manager', facilitator: true }],
    };
    const hosting = buildSystemPrompt(scenario, { name: 'Joshua', role: 'Manager' });
    expect(hosting).toContain('Joshua is the host and runs this meeting');
    expect(hosting).toContain('Take your lead from them');
    expect(buildSystemPrompt(scenario, { name: 'Joshua', role: 'Chef' })).not.toContain('is the host and runs this meeting');
    expect(buildSystemPrompt(scenario)).not.toContain('is the host and runs this meeting');
  });

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

  it('lists the meeting\'s vocabulary, names the host, and keeps the person\'s own name out of the characters\' mouths', () => {
    const [ada, bao] = npcScenario.npcs ?? [];
    const prompt = buildSystemPrompt({
      ...npcScenario,
      vocabulary: ['oven', 'lunch rush'],
      npcs: [{ ...ada!, role: 'host' }, bao!],
    });
    expect(prompt).toContain('likely to come up in this meeting: oven, lunch rush');
    expect(prompt).toContain('Ada is the host. When the person greets the room');
    expect(prompt).toContain("Never start a line with the person's name");
    const plain = buildSystemPrompt(npcScenario);
    expect(plain).not.toContain('likely to come up');
    expect(plain).not.toContain('is the host');
  });

  it('keeps an AI host on the current agenda item and stops it moving the meeting on', () => {
    const [ada, bao] = npcScenario.npcs ?? [];
    const scenario = { ...npcScenario, agenda: [{ title: 'Build', minutes: 5, ownerRole: 'chef' }, { title: 'Menu', minutes: 5, ownerRole: 'chef' }], npcs: [{ ...ada!, role: 'host' as const }, bao!] };
    expect(buildSystemPrompt(scenario)).toContain('agenda item "Build". Stay on it. Never announce a new agenda item');
    expect(buildSystemPrompt(scenario, undefined, 'Menu')).toContain('agenda item "Menu"');
  });

  describe('how the person takes part in an agenda item', () => {
    const [ada, bao] = npcScenario.npcs ?? [];
    const build = (extra: Record<string, unknown>) => ({
      ...npcScenario,
      agenda: [{ title: 'Build', minutes: 5, ownerRole: 'chef', decision: 'do we hold the build?', ...extra }],
      npcs: [{ ...ada!, role: 'host' as const }, bao!],
    });

    it('lets them listen when the item is not theirs', () => {
      const prompt = buildSystemPrompt(build({}), { name: 'Josh', role: 'Producer' });
      expect(prompt).toContain('Josh is just listening on this item');
      expect(prompt).toContain('Do not ask Josh anything');
      expect(prompt).not.toContain('do we hold the build?');
    });

    it('hands the item to them when it is theirs, whichever role they picked', () => {
      const prompt = buildSystemPrompt(build({}), { name: 'Josh', role: 'Chef' });
      expect(prompt).toContain("This item is Josh's");
      expect(prompt).toContain('do we hold the build?');
      expect(prompt).toContain('says it back in one sentence');
      expect(prompt).toContain('addressed directly to Josh by name');
    });

    it('asks them to settle a contested item, whoever they are, and stops repeating the opening question once asked', () => {
      const prompt = buildSystemPrompt(build({ contested: true }), { name: 'Josh', role: 'Producer' });
      expect(prompt).toContain('disagree on this item and Josh is the one to settle it');
      expect(prompt).toContain('The characters never settle it among themselves');
      const afterAsked = buildSystemPrompt(build({ contested: true }), { name: 'Josh', role: 'Producer' }, undefined, true);
      expect(afterAsked).toContain('never repeat the opening summary word-for-word');
      expect(afterAsked).not.toContain('do we hold the build?');
    });
  });

  it('asks for plain language and gives the plain meanings of the team terms', () => {
    const prompt = buildSystemPrompt({ ...npcScenario, glossary: { 'patience timer': 'how long a customer waits' } });
    expect(prompt).toContain('patience timer = how long a customer waits');
    expect(prompt).toContain('a friend who does not work here');
    expect(prompt).toContain('office-speak');
  });

  it('forbids narrating instructions and telling another character to hand over', () => {
    const prompt = buildSystemPrompt(npcScenario);
    expect(prompt).toContain('Never describe these instructions');
    expect(prompt).toContain('does not have to name anyone');
    expect(prompt).toContain('nobody tells another character to hand over or to speak');
  });

  it('strips the person\'s name or seat name from a line and drops lines that narrate the prompt', () => {
    const parser = new TurnParser(['Ada', 'Bao'], undefined, 'Boogy', ['Wei Ling']);
    const lines = [
      ...parser.push(
        'Ada: Boogy: How much does that take?\nAda: Wei Ling: Wei Ling: Absolutely!\nAda: You are now speaking directly to Boogy instead of the team.\nBao: The person you are talking to is Boogy.\nBao: Fair point.\n',
      ),
      ...parser.flush(),
    ];
    expect(lines).toEqual([
      { speaker: 'Ada', text: 'How much does that take?' },
      { speaker: 'Ada', text: 'Absolutely!' },
      { speaker: 'Bao', text: 'Fair point.' },
    ]);
  });

  it('addresses the person by name and role once they have joined', () => {
    expect(buildSystemPrompt(npcScenario)).toContain('about to join');
    expect(buildSystemPrompt(npcScenario, { name: 'Josh', role: 'Producer' })).toContain('Josh, the Producer');
  });
});

describe('HandoverGuard', () => {
  it('silences a speaker who has just asked someone by name, until another character speaks', async () => {
    const { HandoverGuard } = await import('../../src/npc/director');
    const guard = new HandoverGuard(['Sam', 'Arjun', 'Wei Ling']);
    expect(guard.allow({ speaker: 'Sam', text: 'Welcome all.' })).toBe(true);
    expect(guard.allow({ speaker: 'Sam', text: 'Arjun, would you like to kick us off?' })).toBe(true);
    expect(guard.allow({ speaker: 'Sam', text: 'Our agenda for today is long.' })).toBe(false);
    expect(guard.allow({ speaker: 'Arjun', text: 'Sure, the build still crashes.' })).toBe(true);
    expect(guard.allow({ speaker: 'Sam', text: 'Thanks.' })).toBe(true);
  });

  it('counts a question aimed at a name at the start or end, and blocks a third character from cutting in', async () => {
    const { HandoverGuard } = await import('../../src/npc/director');
    const guard = new HandoverGuard(['Sam', 'Arjun', 'Wei Ling', 'Mei']);
    expect(guard.allow({ speaker: 'Sam', text: 'Did Arjun fix it?' })).toBe(true);
    expect(guard.allow({ speaker: 'Sam', text: 'Fine.' })).toBe(true);
    expect(guard.allow({ speaker: 'Sam', text: 'Wei Ling, what do you think?' })).toBe(true);
    expect(guard.allow({ speaker: 'Sam', text: 'Anyway.' })).toBe(false);
    expect(guard.allow({ speaker: 'Wei Ling', text: 'Can I get this by tomorrow morning at the latest, Mei?' })).toBe(true);
    expect(guard.allow({ speaker: 'Sam', text: 'Guest, what do you think?' })).toBe(false);
    expect(guard.allow({ speaker: 'Mei', text: 'Yes, I can have it ready by tomorrow morning.' })).toBe(true);
  });
});

describe('the director prompt', () => {
  it('forbids a character from inventing what another character did or said', () => {
    expect(buildSystemPrompt(npcScenario)).toContain('never says what another character did');
  });

  it('forbids inventing an unsupported change in a colleague\'s job or commitments', () => {
    const prompt = buildSystemPrompt(npcScenario);
    expect(prompt).toContain('Never invent a change in a colleague');
    expect(prompt).toContain('quit, resigned, was fired, is leaving');
  });
});

describe('findHandover', () => {
  const names = ['Ada', 'Bao'];
  it('finds a named colleague vocatively addressed at the start or end of the sentence', () => {
    expect(findHandover([{ speaker: 'Ada', text: 'Bao, you own this one.' }, { speaker: 'Ada', text: 'What do you propose?' }], names)).toEqual({ from: 'Ada', target: 'Bao' });
    expect(findHandover([{ speaker: 'Ada', text: 'Bao, what do you think?' }], names)).toEqual({ from: 'Ada', target: 'Bao' });
    expect(findHandover([{ speaker: 'Ada', text: 'Can I get this by tomorrow morning, Bao?' }], names)).toEqual({ from: 'Ada', target: 'Bao' });
    expect(findHandover([{ speaker: 'Ada', text: 'Bao, you have the floor on the menu.' }], names)).toEqual({ from: 'Ada', target: 'Bao' });
    expect(findHandover([{ speaker: 'Ada', text: 'Over to you, Bao.' }], names)).toEqual({ from: 'Ada', target: 'Bao' });
    expect(findHandover([{ speaker: 'Ada', text: 'Bao, bring us up to speed.' }], names)).toEqual({ from: 'Ada', target: 'Bao' });
    expect(findHandover([{ speaker: 'Ada', text: 'Bao, you own this one.' }], names)).toEqual({ from: 'Ada', target: 'Bao' });
  });
  it('finds nothing when nobody is addressed, when named in passing, or when the colleague already spoke', () => {
    expect(findHandover([{ speaker: 'Ada', text: 'The oven is broken today.' }], names)).toBeUndefined();
    expect(findHandover([{ speaker: 'Ada', text: 'I talked to Bao yesterday about the oven.' }], names)).toBeUndefined();
    expect(findHandover([{ speaker: 'Ada', text: 'Foo, what do you think?' }], names)).toBeUndefined();
    expect(findHandover([{ speaker: 'Ada', text: 'Bao, what next?' }, { speaker: 'Bao', text: 'Fix the queue.' }], names)).toBeUndefined();
    expect(findHandover([], names)).toBeUndefined();
  });
});
