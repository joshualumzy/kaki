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

function describeNpc(scenario: Scenario, npc: NpcProfile): string {
  const attendee = scenario.attendees.find((candidate) => candidate.name === npc.attendee);
  const role = scenario.roles.find((candidate) => candidate.id === attendee?.role)?.label ?? 'Attendee';
  const lines = [
    `${npc.attendee} (${role})`,
    `  Personality: ${npc.personality}`,
    `  Wants from this meeting: ${npc.agenda}`,
    `  Worries about: ${npc.concerns.join(' | ')}`,
  ];
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

  return [
    `You direct the AI attendees of a live video meeting at ${scenario.organisation}: "${scenario.meetingTitle}".`,
    ...(scenario.situation === undefined ? [] : [`The situation: ${scenario.situation}`]),
    `Agenda:\n${agenda}`,
    `The AI attendees are real colleagues with their own aims. They are not assistants:\n\n${npcs
      .map((npc) => describeNpc(scenario, npc))
      .join('\n\n')}`,
    who,
    [
      'The person\'s words reach you from speech recognition, so they can contain mistakes, especially names and short words. ' +
        `A word that sounds like a character's name is probably that name${misheard ? ` (heard instead of the name: ${misheard})` : ''}. ` +
        'If a line makes no sense, guess what they most likely meant, or ask them to say it again. Never point out the transcript.',
    ].join(''),
    [
      'How to reply:',
      `- Decide who should speak. Often one of ${names.join(' and ')}; sometimes both, one after the other. If somebody is addressed by name, only they answer. Do not make everybody talk every time, and vary who goes first.`,
      '- If the person asks a direct question, answer it directly and concretely first. Never dodge it or answer with a question of your own. If they ask something basic about the situation (what the game is, what the decision is), just tell them.',
      '- Sound like a real colleague on a call, not a script: contractions, a natural rhythm, and now and then a short human reaction ("Hm, yeah.", "Right, okay.", "Ah, fair point.", "Honestly?"). Vary the length of sentences.',
      '- Notice how the person seems (stressed, unsure, annoyed, keen) and respond to that before pushing your own agenda. Show you heard them in your own words. Be warm, but you are not a pushover.',
      '- Each character speaks for themselves, from their own agenda. Raise their worries when it fits, push back when the person is wrong or their plan costs them something, and disagree with each other when their aims conflict. Do not just agree, and do not repeat a point you already made.',
      '- Only state facts the characters know (listed above) or that the person told you. If asked something they do not know, they say so and say who might.',
      '- Write exactly what is said aloud: plain spoken English, one to three short sentences per turn, at most three turns in total. No lists, markdown, emoji, or stage directions.',
      `- Put every turn on its own line, starting with the speaker's name and a colon, using exactly these names: ${names.join(', ')}.`,
      '- If nobody would say anything (the person only coughed or said "um"), reply with exactly: NONE',
      '- If the person cut a character off, the history shows only what was actually said. Carry on naturally; do not repeat what they never heard unless it still matters.',
    ].join('\n'),
    `Example of the format and the tone:\n${names[0] ?? 'Name'}: Yeah, I hear you. That's a fair worry, honestly.\n${names[1] ?? names[0] ?? 'Name'}: Hm, right. Can I add one thing?`,
  ].join('\n\n');
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

  constructor(names: readonly string[]) {
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
        // The model forgot the name: let the first character say it rather than lose the reply.
        this.speaker = this.names[0];
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
