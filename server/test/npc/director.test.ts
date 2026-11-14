import { describe, expect, it } from 'vitest';
import { addressedCharacter, buildSystemPrompt, cleanSpoken, findHandover, pushingColleague, TurnParser, type Utterance } from '../../src/npc/director';
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

function parseWithLogs(pieces: string[]): { lines: Utterance[]; logs: string[] } {
  const logs: string[] = [];
  const parser = new TurnParser(['Ada', 'Bao'], undefined, 'Visitor', [], (line) => logs.push(line));
  return { lines: [...pieces.flatMap((piece) => parser.push(piece)), ...parser.flush()], logs };
}

describe('meeting carry-over prompt', () => {
  it('tells the room to raise its catch before accepting the visitor\'s first idea', () => {
    const scenario = {
      ...npcScenario,
      agenda: [{ ...testScenario.agenda[0]!, contested: true }],
      roles: [...npcScenario.roles, { id: 'host', label: 'Host', facilitator: true }],
      attendees: [...npcScenario.attendees, { name: 'Hal', role: 'host', zoomDisplayName: 'Hal (Host)' }],
      npcs: [...npcScenario.npcs, { attendee: 'Hal', role: 'host' as const, voice: 'v0', personality: 'Calm', agenda: 'Keep time', concerns: [] }],
    };
    const prompt = buildSystemPrompt(scenario, { name: 'Visitor', role: 'chef' });
    expect(prompt).toContain("Visitor's first idea for this item");
    expect(prompt).toContain('raise that catch');
    expect(prompt).toContain("Visitor's second idea");
  });

  it('shows an earlier decision and only an actual link to that earlier agenda item', () => {
    const scenario = { ...npcScenario, agenda: [
      { title: 'Prep', minutes: 5, ownerRole: 'chef' },
      { title: 'Service', minutes: 5, ownerRole: 'cashier', links: [{ with: 'Prep', effect: 'The earlier call reduces available staff.' }] },
    ] };
    const memory = [{ kind: 'decision' as const, item: 'Prep', text: 'Use one person on setup.' }];
    const linked = buildSystemPrompt(scenario, undefined, 'Service', false, false, [], memory);
    expect(linked).toContain('Decision on Prep: Use one person on setup.');
    expect(linked).toContain('fact from the scenario or meeting memory');
    expect(linked).toContain('Prep: The earlier call reduces available staff.');
    const unlinked = buildSystemPrompt({ ...scenario, agenda: [scenario.agenda[0]!,
      { title: 'Service', minutes: 5, ownerRole: 'cashier' }] }, undefined, 'Service', false, false, [], memory);
    expect(unlinked).toContain('Decision on Prep: Use one person on setup.');
    expect(unlinked).not.toContain('The earlier call reduces available staff.');
    expect(unlinked).not.toContain('Links to other items in this meeting:');
    const reopened = buildSystemPrompt(scenario, undefined, 'Service', false, false, [], memory, 'Prep', ['Prep']);
    expect(reopened).toContain('Current item: Prep.');
    expect(reopened).toContain('while the meeting remains on its current agenda item');
  });

  it('does not expose a link to a topic outside this meeting', () => {
    const scenario = { ...npcScenario, agenda: [
      { title: 'Prep', minutes: 5, ownerRole: 'chef' },
      { title: 'Service', minutes: 5, ownerRole: 'cashier', links: [{ with: 'Other', effect: 'Do a hidden action.' }] },
    ] };
    expect(buildSystemPrompt(scenario, undefined, 'Service')).not.toContain('Do a hidden action.');
  });
});

describe('TurnParser', () => {
  it('cuts whole sentences after three per speaker turn and logs each cut', () => {
    const logs: string[] = [];
    const parser = new TurnParser(['Ada', 'Bao'], undefined, 'Visitor', [], (line) => logs.push(line));
    const reply = 'Ada: One. Two. Three. Four. Five. Bao: Six.';
    expect([...parser.push(reply), ...parser.flush()].map((line) => `${line.speaker}: ${line.text}`)).toEqual([
      'Ada: One.', 'Ada: Two.', 'Ada: Three.', 'Bao: Six.',
    ]);
    expect(logs).toEqual([
      '[length-backstop] Ada: dropped sentence 4 of turn',
      '[length-backstop] Ada: dropped sentence 5 of turn',
    ]);
  });

  it('keeps a final question addressed to the visitor after the third sentence', () => {
    const logs: string[] = [];
    const parser = new TurnParser(['Ada'], undefined, 'Visitor', [], (line) => logs.push(line));
    expect([...parser.push('Ada: One. Two. Three. Four. Visitor, what do you think?'), ...parser.flush()].map((line) => line.text)).toEqual([
      'One.', 'Two.', 'Three.', 'Visitor, what do you think?',
    ]);
    expect(logs).toEqual(['[length-backstop] Ada: dropped sentence 4 of turn']);
  });
  it('keeps the same cuts and logs across mid-word, mid-sentence and speaker-label splits', () => {
    const reply = 'Ada: One. Two. Three. Four. Five. Bao: Six.';
    const whole = parseWithLogs([reply]);
    expect(whole.lines.map((line) => `${line.speaker}: ${line.text}`)).toEqual([
      'Ada: One.', 'Ada: Two.', 'Ada: Three.', 'Bao: Six.',
    ]);
    expect(whole.logs).toEqual([
      '[length-backstop] Ada: dropped sentence 4 of turn',
      '[length-backstop] Ada: dropped sentence 5 of turn',
    ]);
    expect(parseWithLogs(['Ad', 'a: One. Tw', 'o. Three. Fo', 'ur. Five. Ba', 'o: Six.'])).toEqual(whole);
    expect(parseWithLogs(['Ada: One. Two. Three. Four. Five. ', 'Bao:', ' Six.'])).toEqual(whole);
  });

  it('holds a split final visitor question and logs only the dropped earlier sentence', () => {
    const reply = 'Ada: One. Two. Three. Four. Visitor, what do you think?';
    const whole = parseWithLogs([reply]);
    expect(whole.lines.map((line) => line.text)).toEqual(['One.', 'Two.', 'Three.', 'Visitor, what do you think?']);
    expect(whole.logs).toEqual(['[length-backstop] Ada: dropped sentence 4 of turn']);
    expect(parseWithLogs(['Ada: One. Tw', 'o. Three. Four. Vis', 'itor, what do you th', 'ink?'])).toEqual(whole);
  });
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

describe('pushingColleague', () => {
  const scenario = {
    ...testScenario,
    roles: [...testScenario.roles, { id: 'host', label: 'Host' }],
    attendees: [...testScenario.attendees, { name: 'Hal', role: 'host', zoomDisplayName: 'Hal (Host)' }],
  };
  const item = {
    ...testScenario.agenda[0]!,
    discussion: {
      openingViews: [{ attendee: 'Hal', view: 'Host view' }, { attendee: 'Bao', view: 'Other view' }],
      tradeOffs: [],
    },
  };
  const present = ['Hal', 'Ada', 'Bao'];

  it('chooses the owner when present and eligible', () => {
    expect(pushingColleague(scenario, item, 'Guest', present, 'Hal')).toBe('Ada');
  });
  it('skips an owner occupying the visitor seat', () => {
    expect(pushingColleague(scenario, item, 'Chef', present, 'Hal')).toBe('Bao');
  });
  it('skips an owner absent from the meeting', () => {
    expect(pushingColleague(scenario, item, 'Guest', ['Hal', 'Bao'], 'Hal')).toBe('Bao');
  });
  it('skips a host owner and uses the first eligible opening view', () => {
    expect(pushingColleague(scenario, { ...item, ownerRole: 'host' }, 'Guest', present, 'Hal')).toBe('Bao');
  });
  it('uses trade-offs, then any present colleague, then no name', () => {
    const fallback = { ...item, ownerRole: 'host', discussion: {
      openingViews: [{ attendee: 'Hal', view: 'Host view' }],
      tradeOffs: [{ attendee: 'Bao', role: 'cashier', tradeOff: 'A cost', question: 'Which cost?' }],
    } };
    expect(pushingColleague(scenario, fallback, 'Guest', present, 'Hal')).toBe('Bao');
    expect(pushingColleague(scenario, { ...fallback, discussion: undefined }, 'Guest', present, 'Hal')).toBe('Ada');
    expect(pushingColleague(scenario, fallback, 'Chef', ['Hal', 'Ada'], 'Hal')).toBeUndefined();
  });
  it('omits the pushing sentence when only the host is present', () => {
    const prompt = buildSystemPrompt({
      ...scenario,
      agenda: [{ ...item, contested: true }],
      npcs: [{ attendee: 'Hal', role: 'host', voice: 'v', personality: 'Calm', agenda: 'Help', concerns: [] }],
    }, { name: 'Visitor', role: 'Chef' });
    expect(prompt).toContain('Visitor decides this item regardless of seat.');
    expect(prompt).not.toContain('presses the issue hardest');
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
  it('mentions links only to items in the active meeting', () => {
    const first = { ...npcScenario.agenda[0]!, title: 'Present' };
    const later = { ...npcScenario.agenda[1]!, title: 'Later', links: [
      { with: 'Present', effect: 'present effect' },
      { with: 'Absent', effect: 'absent effect' },
    ] };
    const prompt = buildSystemPrompt({ ...npcScenario, agenda: [first, later] }, undefined, later.title,
      false, false, [], [{ kind: 'decision', item: 'Present', text: 'Earlier call.' }]);
    expect(prompt).toContain('Present: present effect');
    expect(prompt).not.toContain('Absent');
    expect(prompt).not.toContain('absent effect');
  });
  it('renders only the current meeting item facts and hidden directions', () => {
    const [ada, bao] = npcScenario.npcs;
    const first = { title: 'First', minutes: 5, ownerRole: 'chef', contested: true,
      background: ['current established fact'], directions: ['current possible direction'],
      seatFacts: { chef: 'current chef fact', cashier: 'current cashier fact' },
      sayExactly: ['42 tickets'], sensitive: true,
      offScreen: { name: 'Pat', role: 'supplier', howTheyAnswer: 'They can confirm once.' } };
    const missing = { title: 'Missing', minutes: 5, ownerRole: 'chef', background: ['forbidden absent fact'],
      directions: ['forbidden absent direction'], seatFacts: { chef: 'forbidden absent seat fact' } };
    const scenario = { ...npcScenario, agenda: [first, missing], npcs: [{ ...ada!, role: 'host' as const }, bao!] };
    const prompt = buildSystemPrompt(scenario, { name: 'Visitor', role: 'Cashier' }, 'First');
    expect(prompt).toContain('current established fact');
    expect(prompt).toContain('current possible direction');
    expect(prompt).toContain("Ada's fact for this item: current chef fact");
    expect(prompt).not.toContain('current cashier fact');
    expect(prompt).toContain('Pat (supplier)');
    expect(prompt).toContain('They can confirm once.');
    expect(prompt).toContain('no jokes, no blame');
    expect(prompt).toContain('42 tickets');
    expect(prompt).not.toContain('forbidden absent');
    const nextPrompt = buildSystemPrompt({ ...scenario, agenda: [missing] }, { name: 'Visitor', role: 'Cashier' }, 'Missing');
    expect(nextPrompt).not.toContain('current established fact');
    expect(nextPrompt).not.toContain('Pat (supplier)');
  });

  it('uses one story clock, rough spoken numbers and no forced question or exact spoken title', () => {
    const [ada, bao] = npcScenario.npcs;
    const scenario = { ...npcScenario, npcs: [{ ...ada!, role: 'host' as const, temperament: 'Gives way slowly', stake: 'Protects the team' }, bao!] };
    const prompt = buildSystemPrompt(scenario, { name: 'Visitor', role: 'Chef' });
    expect(prompt).toContain('Temperament: Gives way slowly');
    expect(prompt).toContain('Stake: Protects the team');
    expect(prompt).toContain('Story time comes only from the scenario situation');
    expect(prompt).not.toContain('current local time:');
    expect(prompt).not.toContain('time of day (');
    expect(prompt).toContain('At most two figures in a spoken sentence');
    expect(prompt).not.toContain('last line of the reply is a short question');
    expect(prompt).not.toContain('Every reply while this item is open');
    expect(prompt).not.toContain('ask for the exact followUp.title');
    expect(prompt).not.toContain('Propose practical choices so the person can simply pick');
  });
  it('uses the visitor role label in item and colleague framing', () => {
    const scenario = {
      ...npcScenario,
      roles: npcScenario.roles.map((role) => role.id === 'chef' ? { ...role, id: 'seat_42', label: 'Kitchen Lead' } : role),
      attendees: npcScenario.attendees.map((attendee) => attendee.role === 'chef' ? { ...attendee, role: 'seat_42' } : attendee),
      agenda: npcScenario.agenda.map((item) => ({ ...item, ownerRole: 'seat_42' })),
      npcs: npcScenario.npcs.map((npc, index) => ({ ...npc, ...(index === 0 ? { role: 'host' as const } : {}),
        withRoles: { seat_42: 'Relies on their call.' } })),
    };
    const prompt = buildSystemPrompt(scenario, { name: 'Visitor', role: 'seat_42' }, 'Prep');
    expect(prompt).toContain('Visitor decides this item regardless of seat');
    expect(prompt).toContain('Towards Visitor (Kitchen Lead)');
    expect(prompt).not.toContain('seat_42');
  });
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
    expect(prompt).toContain('answer it directly and concretely from the current scenario facts');
    expect(prompt).toContain("Notice the visitor's mood");
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
    for (const text of ['Part: the host', 'Sounds like: Brisk and dry', 'Quietly wants (does not say outright): Finish early', 'Disagrees with: Bao about the menu', 'Part: quiet observer', 'answer each other briefly']) {
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
    expect(prompt).toContain('Ada is the host. On greetings, wrap-ups and quiet moments');
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
      expect(prompt).toContain('Josh decides this item regardless of seat');
      expect(prompt).toContain('do we hold the build?');
      expect(prompt).toContain('briefly confirms only the decision Josh actually spoke');
      expect(prompt).not.toContain('Every reply while this item is open');
    });

    it('asks them to settle a contested item, whoever they are, and stops repeating the opening question once asked', () => {
      const prompt = buildSystemPrompt(build({ contested: true }), { name: 'Josh', role: 'Producer' });
      expect(prompt).toContain('Josh decides this item regardless of seat');
      expect(prompt).toContain('Ask Josh a question only when their input or a decision is really needed');
      const afterAsked = buildSystemPrompt(build({ contested: true }), { name: 'Josh', role: 'Producer' }, undefined, true);
      expect(afterAsked).toContain('Do not repeat the opening summary word-for-word');
      expect(afterAsked).not.toContain('The decision on the table is: do we hold the build?');
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

  it('keeps the follow-up with the visitor without telling a colleague to point at the card', () => {
    const [ada, bao] = npcScenario.npcs ?? [];
    const scenario = { ...npcScenario, npcs: [{ ...ada!, role: 'host' as const }, bao!] };
    const prompt = buildSystemPrompt(scenario, { name: 'Visitor', role: 'Chef' });
    expect(prompt).toContain('The visitor owns this follow-up card and its draft');
    expect(prompt).toContain('Never tell the visitor to send, post, email or share');
    expect(prompt).not.toContain('point them to their card');
    expect(prompt).toContain('never mention the card, the screen or the panel');
    expect(prompt).toContain('no colleague says they will draft, post, send or email it themselves');
  });

  it('forbids inventing an unsupported change in a colleague\'s job or commitments', () => {
    const prompt = buildSystemPrompt(npcScenario);
    expect(prompt).toContain('Never invent a change in a colleague');
    expect(prompt).toContain('quit, resigned, was fired, is leaving');
  });

  it('keeps colleague speech natural: one signature worry, varied openers, few figures', () => {
    const prompt = buildSystemPrompt(npcScenario, { name: 'Visitor', role: 'Chef' });
    expect(prompt).toContain("signature worry is said once per meeting");
    expect(prompt).toContain('Vary how lines open');
    expect(prompt).toContain('At most two figures in a spoken sentence');
  });

  it('gives the host a natural acknowledgement instead of a bare Noted', () => {
    const [ada, bao] = npcScenario.npcs ?? [];
    const scenario = { ...npcScenario, npcs: [{ ...ada!, role: 'host' as const }, bao!] };
    expect(buildSystemPrompt(scenario, { name: 'Visitor', role: 'Chef' }))
      .toContain('Never answer with a bare "Noted."');
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
    expect(findHandover([{ speaker: 'Ada', text: 'Bao is right about the margin hit, so how do you want to handle this, Foo?' }], names, 'Foo')).toBeUndefined();
    expect(findHandover([{ speaker: 'Ada', text: 'Bao mentioned the oven yesterday.' }], names)).toBeUndefined();
    expect(findHandover([{ speaker: 'Ada', text: 'Foo, what do you think?' }], names)).toBeUndefined();
    expect(findHandover([{ speaker: 'Ada', text: 'Bao, what next?' }, { speaker: 'Bao', text: 'Fix the queue.' }], names)).toBeUndefined();
    expect(findHandover([], names)).toBeUndefined();
  });
});
