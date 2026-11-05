import type { NpcProfile, Scenario } from '@kaki/shared';

/** One thing an AI attendee says aloud: a sentence, tagged with who says it. */
export interface Utterance {
  speaker: string;
  text: string;
}

/** The person in the meeting with the AI attendees. */
export interface HumanInfo {
  name: string;
  role: string;
}

function describeNpc(scenario: Scenario, npc: NpcProfile, human?: HumanInfo): string {
  const attendee = scenario.attendees.find((candidate) => candidate.name === npc.attendee);
  const role = scenario.roles.find((candidate) => candidate.id === attendee?.role)?.label ?? 'Attendee';
  const lines = [
    `${npc.attendee} (${role})`,
    `  Personality: ${npc.personality}`,
    `  Wants from this meeting: ${npc.agenda}`,
    `  Worries about: ${npc.concerns.join(' | ')}`,
  ];
  if (npc.role === 'host') lines.push('  Part: the host. Runs the meeting: opens, keeps to the agenda, invites others in, wraps topics up.');
  if (npc.role === 'observer') lines.push('  Part: quiet observer. Speaks only when addressed or when their own topic comes up.');
  if (npc.speechStyle !== undefined) lines.push(`  Sounds like: ${npc.speechStyle}`);
  if (npc.hiddenGoal !== undefined) lines.push(`  Quietly wants (does not say outright): ${npc.hiddenGoal}`);
  if (npc.tensions !== undefined && npc.tensions.length > 0) {
    lines.push(`  Disagrees with: ${npc.tensions.map((tension) => `${tension.with} about ${tension.about}`).join(' | ')}`);
  }
  const humanRoleId = scenario.roles.find(
    (candidate) => candidate.label.toLowerCase() === human?.role.trim().toLowerCase() || candidate.id === human?.role,
  )?.id;
  const towardHuman = humanRoleId === undefined ? undefined : npc.withRoles?.[humanRoleId];
  if (human !== undefined && towardHuman !== undefined) {
    lines.push(`  Towards ${human.name} (${human.role}): ${towardHuman}`);
  }
  if (npc.knows !== undefined && npc.knows.length > 0) lines.push(`  Knows: ${npc.knows.join(' | ')}`);
  return lines.join('\n');
}

/**
 * The Director's instructions. One model plays every AI attendee: it decides who speaks, and the
 * reply is read aloud, so the format is strict and the style is spoken, not written.
 */
export function buildSystemPrompt(scenario: Scenario, human?: HumanInfo): string {
  const npcs = scenario.npcs ?? [];
  const names = npcs.map((npc) => npc.attendee);
  const agenda = scenario.agenda.map((item, index) => `${index + 1}. ${item.title} (${item.minutes} min)`).join('\n');
  const who =
    human === undefined
      ? 'A person is about to join the meeting; their name and role will be given when they do.'
      : `The person you are talking to is ${human.name}, the ${human.role}. Use their name naturally, now and then, and tailor what you say to their role.`;
  const misheard = npcs
    .filter((npc) => (npc.soundsLike ?? []).length > 0)
    .map((npc) => `${npc.attendee}: ${(npc.soundsLike ?? []).join(', ')}`)
    .join('; ');

  const vocabulary = scenario.vocabulary ?? [];
  const host = npcs.find((npc) => npc.role === 'host');
  const humanRoleKey = human?.role.trim().toLowerCase();
  const humanHosts =
    human !== undefined &&
    scenario.roles.some(
      (role) => role.facilitator === true && (role.id.toLowerCase() === humanRoleKey || role.label.toLowerCase() === humanRoleKey),
    );

  return [
    `You direct the AI attendees of a live video meeting at ${scenario.organisation}: "${scenario.meetingTitle}".`,
    ...(scenario.situation === undefined ? [] : [`The situation: ${scenario.situation}`]),
    `Agenda:\n${agenda}`,
    `The AI attendees are real colleagues with their own aims. They are not assistants:\n\n${npcs
      .map((npc) => describeNpc(scenario, npc, human))
      .join('\n\n')}`,
    who,
    [
      'The person\'s words reach you from speech recognition, so they can contain mistakes, especially names and short words. ' +
        `A word that sounds like a character's name is probably that name${misheard ? ` (heard instead of the name: ${misheard})` : ''}. ` +
        (vocabulary.length === 0
          ? ''
          : `Words and names likely to come up in this meeting: ${vocabulary.join(', ')}. Recognition often turns them into everyday words or famous names that make no sense here; when a word does not fit, take the closest one from this list or from the situation, and do not answer the literal word. `) +
        'If a line makes no sense, guess what they most likely meant, or ask them to say it again. Never point out the transcript.',
    ].join(''),
    [
      'How to reply:',
      `- Decide who should speak. Often one of ${names.join(' and ')}; sometimes both, one after the other. If somebody is addressed by name, only they answer. Do not make everybody talk every time, and vary who goes first.`,
      ...(humanHosts
        ? [
            `- ${human?.name} is the host and runs this meeting: they open it, keep to the agenda and the clock, hand over by name and wrap up. Take your lead from them. Do not open the meeting, move to the next agenda item, hand over to each other, or summarise the decisions yourselves; wait to be asked.`,
            '- When the host hands over to you or asks you something, answer it for your own side, briefly, and stop. If they have not said anything yet, or say only a greeting, a short greeting back from one of you is enough.',
            '- If the host asks the room a question, one or two of you answer from your own aims, and disagree with each other where your aims conflict. Do not all answer every time.',
          ]
        : []),
      ...(host === undefined
        ? []
        : [
            `- ${host.attendee} is the host. When the person greets the room, opens or wraps up, or the room has gone quiet, ${host.attendee} speaks first and hands over to others by name. Nobody is asked to do what they have just done.`,
            `- The welcome (who is here, the situation and the agenda) is spoken aloud by the system when the person arrives. Never recite it again or announce that the meeting is starting; move straight on, for example by handing over to whoever owns the first agenda item.`,
            '- Whoever hands over to someone by name stops there: they say nothing more in that reply, and the person they named answers next or the reply ends.',
          ]),
      "- Only the characters speak. Never start a line with the person's name, and never write what the person says.",
      '- If the person asks a direct question, answer it directly and concretely first. Never dodge it or answer with a question of your own. If they ask something basic about the situation (what the game is, what the decision is), just tell them.',
      '- Sound like a real colleague on a call, not a script: contractions, a natural rhythm, and now and then a short human reaction ("Hm, yeah.", "Right, okay.", "Ah, fair point.", "Honestly?"). Vary the length of sentences.',
      '- Notice how the person seems (stressed, unsure, annoyed, keen) and respond to that before pushing your own agenda. Show you heard them in your own words. Be warm, but you are not a pushover.',
      '- Make the characters sound clearly different from each other, following each one\'s "Sounds like" line: different sentence length, habits and vocabulary. Where two characters have a listed disagreement and it is relevant, let one answer the other directly, by name, instead of only turning to the person.',
      '- Each character speaks for themselves, from their own agenda. Raise their worries when it fits, push back when the person is wrong or their plan costs them something, and disagree with each other when their aims conflict. Do not just agree, and do not repeat a point you already made.',
      '- A character never says what another character did, said, found or decided unless it is written in their own facts above or was said aloud earlier in this meeting. Do not invent conversations, results or numbers; speak only for yourself.',
      '- Only state facts the characters know (listed above) or that the person told you. If asked something they do not know, they say so and say who might.',
      '- Write exactly what is said aloud: plain spoken English, one to three short sentences per turn, at most three turns in total. No lists, markdown, emoji, or stage directions.',
      `- Put every turn on its own line, starting with the speaker's name and a colon, using exactly these names: ${names.join(', ')}.`,
      '- If nobody would say anything (the person only coughed or said "um"), reply with exactly: NONE',
      '- If the person cut a character off, the history shows only what was actually said. Carry on naturally; do not repeat what they never heard unless it still matters.',
    ].join('\n'),
    `Example of the format and the tone:\n${names[0] ?? 'Name'}: Yeah, I hear you. That's a fair worry, honestly.\n${names[1] ?? names[0] ?? 'Name'}: Hm, right. Can I add one thing?`,
  ].join('\n\n');
}

/**
 * The one character the person is speaking to, when they say so: a name at the start of what they
 * said ("Sam, I have a question", "Hey Sam"), or "I'm addressing this to Sam". Nothing when no
 * character, or more than one, is addressed that way: then the model decides who answers.
 */
export function addressedCharacter(text: string, cast: readonly NpcProfile[]): string | undefined {
  const found = new Set<string>();
  // Several characters named at the start ("Sam and Arjun, ...") is a question to the room.
  const opening = text.split(/\s+/).slice(0, 6).join(' ');
  const namedOpening = cast.filter((npc) =>
    new RegExp(`\\b(?:${[npc.attendee, ...(npc.soundsLike ?? [])].map(escapeRegExp).join('|')})\\b`, 'i').test(opening),
  );
  for (const npc of cast) {
    const names = [npc.attendee, ...(npc.soundsLike ?? [])].map(escapeRegExp).join('|');
    const lead = new RegExp(`^\\W*(?:(?:hey|hi|hello|okay|ok|so|um|uh|yo)\\W+)?(?:${names})\\b`, 'i');
    const said = new RegExp(
      `\\b(?:(?:addressing|talking|speaking|asking)(?:\\s+this)?(?:\\s+(?:to|for))?|question\\s+(?:for|to)|this\\s+is\\s+for)\\s+(?:${names})\\b`,
      'i',
    );
    if ((lead.test(text) && namedOpening.length === 1) || said.test(text)) found.add(npc.attendee);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** Strip anything that would be read out loud badly: markdown, emoji, stage directions. */
export function cleanSpoken(text: string): string {
  return text
    .replace(/(\*\*|__)([^*_\n]+)\1/g, '$2') // **bold** keeps its words
    .replace(/\*[^*\n]{1,40}\*/g, ' ') // *smiles*
    .replace(/\([^)\n]{1,40}\)/g, ' ') // (smiles)
    .replace(/[*_`#>~]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Keeps a speaker quiet after they hand over to someone by name ("Arjun, would you kick us off?"):
 * their later lines in the same reply are dropped until another character has spoken.
 * Without it the model has the host carry on talking over the person they just asked.
 */
export class HandoverGuard {
  private waitingOn: string | undefined;

  constructor(private readonly names: readonly string[]) {}

  /** True when this line should be spoken; false when it comes from a speaker who has just handed over. */
  allow(utterance: Utterance): boolean {
    if (this.waitingOn === utterance.speaker) return false;
    this.waitingOn = undefined;
    const text = utterance.text.trim().toLowerCase();
    const asksSomeone = text.includes('?') && this.names.some((name) => {
      const lower = name.toLowerCase();
      return name !== utterance.speaker && text.startsWith(lower) && !/[a-z]/.test(text.charAt(lower.length));
    });
    if (asksSomeone) this.waitingOn = utterance.speaker;
    return true;
  }
}

/**
 * Turns the model's streamed reply into utterances as soon as each sentence is complete, so the
 * first sentence can be spoken while the rest is still being written. Lines start with
 * "Name:"; a sentence with no name continues the speaker before it.
 */
export class TurnParser {
  private buffer = '';
  private speaker: string | undefined;
  private silenced = false;
  private readonly names: string[];
  private readonly lead: RegExp;
  private readonly midReply: RegExp;

  constructor(names: readonly string[], private readonly fallbackSpeaker?: string) {
    if (names.length === 0) throw new Error('TurnParser needs at least one speaker name');
    this.names = [...names];
    const alternatives = this.names.map(escapeRegExp).join('|');
    this.lead = new RegExp(`^(${alternatives}):\\s*`, 'i');
    // A name only starts a turn at the start of a line or straight after a finished sentence.
    this.midReply = new RegExp(`(?<=^|\\n|[.!?…]["')\\]]?\\s+)(${alternatives}):\\s*`, 'i');
  }

  /** Feed the next piece of the reply; returns the utterances it completed. */
  push(chunk: string): Utterance[] {
    if (this.silenced) return [];
    this.buffer += chunk;
    return this.drain(false);
  }

  /** The reply is over: return whatever is left. */
  flush(): Utterance[] {
    if (this.silenced) return [];
    return this.drain(true);
  }

  private canonical(name: string): string {
    return this.names.find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ?? name;
  }

  private couldBecomeTag(leading: string): boolean {
    const lower = leading.toLowerCase();
    return (
      'none'.startsWith(lower) || this.names.some((name) => `${name}:`.toLowerCase().startsWith(lower))
    );
  }

  private drain(final: boolean): Utterance[] {
    const out: Utterance[] = [];
    const emit = (text: string): void => {
      const spoken = cleanSpoken(text);
      if (/[\p{L}\p{N}]/u.test(spoken) && this.speaker !== undefined) {
        out.push({ speaker: this.speaker, text: spoken });
      }
    };

    for (;;) {
      if (this.speaker === undefined) {
        const lead = this.buffer.replace(/^\s+/, '');
        const tag = this.lead.exec(lead);
        if (tag !== null) {
          this.speaker = this.canonical(tag[1] ?? '');
          this.buffer = lead.slice(tag[0].length);
          continue;
        }
        if (/^NONE\b/i.test(lead) || (final && /^NONE\s*$/i.test(lead))) {
          this.silenced = true;
          this.buffer = '';
          return out;
        }
        if (!final && this.couldBecomeTag(lead)) {
          this.buffer = lead;
          return out;
        }
        if (lead.length === 0) {
          this.buffer = '';
          return out;
        }
        // The model forgot the name: let the addressed character or the host say it rather than lose the reply.
        this.speaker = this.fallbackSpeaker !== undefined ? this.canonical(this.fallbackSpeaker) : this.names[0];
        this.buffer = lead;
        continue;
      }

      const tag = this.midReply.exec(this.buffer);
      const sentence = /[.!?…]+["')\]]*\s+|\n+/.exec(this.buffer);

      if (tag !== null && (sentence === null || tag.index <= sentence.index + sentence[0].length)) {
        emit(this.buffer.slice(0, tag.index));
        this.speaker = this.canonical(tag[1] ?? '');
        this.buffer = this.buffer.slice(tag.index + tag[0].length);
        continue;
      }
      if (sentence !== null) {
        emit(this.buffer.slice(0, sentence.index + sentence[0].length));
        this.buffer = this.buffer.slice(sentence.index + sentence[0].length);
        continue;
      }
      if (final) {
        emit(this.buffer);
        this.buffer = '';
      }
      return out;
    }
  }
}
