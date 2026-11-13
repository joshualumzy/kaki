import { itemMode, type NpcProfile, type Scenario } from '@kaki/shared';

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

/** What the person's role answers for (its role card's responsibility), if the role has a card. */
export function responsibilityFor(scenario: Scenario, human: HumanInfo | undefined): string | undefined {
  const key = human?.role.trim().toLowerCase();
  return scenario.roles.find((role) => role.label.toLowerCase() === key || role.id === human?.role)?.card?.responsibility;
}

/** What the characters do on this agenda item, which depends on how the person takes part in it. */
function itemRules(
  scenario: Scenario,
  human: HumanInfo | undefined,
  host: string,
  names: readonly string[],
  title: string | undefined,
  decision: string | undefined,
  alreadyAsked = false,
): string[] {
  const item = scenario.agenda.find((candidate) => candidate.title === title);
  const person = human?.name ?? 'the person';
  const humanRoleLabel = scenario.roles.find((role) => role.id === human?.role || role.label === human?.role)?.label ?? 'their role';
  const mode = itemMode(scenario, item, human?.role);
  const asked =
    decision === undefined
      ? ''
      : alreadyAsked
        ? ` (${host} already introduced this decision earlier: never repeat the opening summary word-for-word; respond directly to what ${person} just said and ask ${person} by name in fresh, natural words.)`
        : ` The decision on the table is: ${decision}`;
  if (mode === 'observe') {
    return [
      `- ${person} is just listening on this item: it is not theirs. The characters talk it through between themselves so a newcomer can follow: whoever owns the item says where things stand and what it means, another adds the other side. Do not ask ${person} anything or wait for them on this item; answer them if they speak first.`,
    ];
  }
  if (mode === 'involve') {
    return [
      `- This item is ${person}'s (${humanRoleLabel} leads this topic). ${host} hands it to them by name and asks them the question; the others give facts and their view when asked, and wait for ${person}'s answer.${asked} Every reply while this item is open must end with a short, natural question addressed directly to ${person} by name (for example "${person}, ...?" or "..., ${person}?"), so ${person} always knows the room is waiting on them. When ${person} settles on a decision, ${host} (on a "${host}:" line) says it back in one sentence, and one of the other colleagues asks ${person} naturally by name to send out the follow-up deliverable so Kaki can draft it for them (for example "${person}, could you post that decision in the team channel today?" or "${person}, could you email <specific external person/partner name> to confirm?") — or if ${person} already volunteered ("I'll..."), confirms it without asking another question. Never refer to yourself by your own name in the third person.`,
    ];
  }
  const seatOwner = scenario.attendees.find((attendee) => attendee.role === item?.ownerRole)?.name;
  const humanRole = scenario.roles.find((role) => role.id === human?.role || role.label === human?.role)?.id;
  const itemOwner = item?.ownerRole === humanRole ? person : seatOwner;
  const confirmingColleague = itemOwner === person ? host : itemOwner ?? host;
  const leads = [...new Set([...(item?.discussion?.openingViews ?? []).map((view) => view.attendee),
    ...(item?.discussion?.tradeOffs ?? []).map((tradeOff) => tradeOff.attendee)])]
    .filter((name) => name !== host && (itemOwner !== person || name !== seatOwner) && names.includes(name)).slice(0, 2);
  const peerCollaborationRule =
    itemOwner !== undefined && human !== undefined
      ? ` ${itemOwner === person ? `${person} leads this item.` : `${itemOwner} owns this item and ${person} is a peer collaborator.`} The team can offer practical options and ask ${person} how to settle the call. Never mention the screen or Kaki Wingman.`
      : '';
  const wrapUpInstruction =
    `Once ${person} settles on a clear decision, accept it immediately. ${confirmingColleague} confirms only the decision ${person} actually spoke, in natural words, without adding terms, numbers or promises. Ask ${person} for the exact follow-up title named in the hidden control line, unless ${person} volunteered to do it already. Never write a spoken line as the visitor.`;
  const openingTurnGuard = alreadyAsked
    ? ''
    : ` On this opening briefing before ${person} has spoken on the topic, the first speaker shares what happened on the ground and what is at stake for tomorrow morning in plain everyday words; the second speaker responds directly to what the first speaker just said, explaining the competing practical catch on their side without shooting down unmentioned solutions nobody has proposed yet, then asks ${person} by name one simple, open question on how they want to handle it. Leave the decision open so ${person} gets to make the first move.`;
  return [
    `- The characters disagree on this item and ${person} is the one to settle it. Two of them (${leads.join(', ')}) each say their side in plain words and why that trade-off matters from their listed facts about "${title ?? 'this topic'}" ONLY (never invent delays or numbers not in their facts, and NEVER bring up constraints from other agenda items), then ${host} or the last speaker asks ${person} by name in natural words (for example "${person}, ...?" or "..., ${person}?"), so the last line of the reply is a short question addressed directly to ${person} by name.${asked}${openingTurnGuard}${peerCollaborationRule} If ${person} asks a clarifying question first, answer that question directly with the real facts and end by asking ${person} by name what they want to do; never repeat the opening prompt word-for-word, and never have ${host} cut in right after one character just asked another character a question. If ${person} proposes a vague, hand-wavy, or unrealistic idea that ignores a real operational constraint in your facts (such as screen space, engineering hours, budget limits, or queue rules), do NOT blindly rubber-stamp it: raise the specific constraint from your facts in one natural sentence and ask how ${person} wants to handle that trade-off; if ${person} proposes a high-level intent or workaround (such as a dedicated role or a temporary compromise), collaborate and "yes-and" the idea by proposing concrete, practical compromises from your own facts so ${person} only needs to pick or approve. Once ${person} makes a clear, practical call or addresses the constraint, accept it without creating a stalemate. ${wrapUpInstruction} — always using "I/me/my" and NEVER referring to themselves by their own name in the third person. Only use issue-tracker tickets for software or technical bugs; use team channel posts, emails, wiki pages, or calendar invites for non-software topics. The characters never settle it among themselves.`,
  ];
}

function describeNpc(scenario: Scenario, npc: NpcProfile, human?: HumanInfo, includeKnows = true): string {
  const attendee = scenario.attendees.find((candidate) => candidate.name === npc.attendee);
  const role = scenario.roles.find((candidate) => candidate.id === attendee?.role)?.label ?? 'Attendee';
  const humanRoleId = scenario.roles.find(
    (candidate) => candidate.label.toLowerCase() === human?.role.trim().toLowerCase() || candidate.id === human?.role,
  )?.id;
  const seatAttendee = scenario.attendees.find((candidate) => candidate.role === humanRoleId);
  const scrubSeatName = (text: string): string => {
    if (human === undefined || seatAttendee === undefined || seatAttendee.name === human.name) return text;
    const escaped = escapeRegExp(seatAttendee.name);
    return text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), human.name);
  };
  const lines = [
    `${npc.attendee} (${role})`,
    `  Personality: ${scrubSeatName(npc.personality)}`,
    `  Wants from this meeting: ${scrubSeatName(npc.agenda)}`,
    `  Worries about: ${npc.concerns.map(scrubSeatName).join(' | ')}`,
  ];
  if (npc.role === 'host') lines.push('  Part: the host. Runs the meeting: opens, keeps to the agenda, invites others in, wraps topics up.');
  if (npc.role === 'observer') lines.push('  Part: quiet observer. Speaks only when addressed or when their own topic comes up.');
  if (npc.speechStyle !== undefined) lines.push(`  Sounds like: ${scrubSeatName(npc.speechStyle)}`);
  if (includeKnows && npc.hiddenGoal !== undefined) lines.push(`  Quietly wants (does not say outright): ${scrubSeatName(npc.hiddenGoal)}`);
  if (npc.tensions !== undefined && npc.tensions.length > 0) {
    lines.push(
      `  Disagrees with: ${npc.tensions
        .map((tension) => `${tension.with === seatAttendee?.name && human !== undefined ? human.name : tension.with} about ${scrubSeatName(tension.about)}`)
        .join(' | ')}`,
    );
  }
  const towardHuman = humanRoleId === undefined ? undefined : npc.withRoles?.[humanRoleId];
  if (human !== undefined && towardHuman !== undefined) {
    const visitorRoleLabel = scenario.roles.find((candidate) => candidate.id === human.role || candidate.label === human.role)?.label ?? human.role;
    lines.push(`  Towards ${human.name} (${visitorRoleLabel}): ${scrubSeatName(towardHuman)}`);
  }
  if (includeKnows && npc.knows !== undefined && npc.knows.length > 0) lines.push(`  Knows: ${npc.knows.map(scrubSeatName).join(' | ')}`);
  return lines.join('\n');
}

/**
 * The Director's instructions. One model plays every AI attendee: it decides who speaks, and the
 * reply is read aloud, so the format is strict and the style is spoken, not written.
 */
export function buildSystemPrompt(
  scenario: Scenario,
  human?: HumanInfo,
  agendaItem?: string,
  alreadyAsked = false,
  includeKnows = alreadyAsked || human === undefined,
  alreadyIntroduced: readonly string[] = [],
): string {
  const npcs = scenario.npcs ?? [];
  const names = npcs.map((npc) => npc.attendee);
  const agenda = scenario.agenda.map((item, index) => `${index + 1}. ${item.title} (${item.minutes} min)`).join('\n');
  const who =
    human === undefined
      ? 'A person is about to join the meeting; their name and role will be given when they do.'
      : `The person you are talking to is ${human.name}, the ${scenario.roles.find((role) => role.id === human.role || role.label === human.role)?.label ?? human.role}. Use their name naturally, now and then, and tailor what you say to their role.`;
  const misheard = npcs
    .filter((npc) => (npc.soundsLike ?? []).length > 0)
    .map((npc) => `${npc.attendee}: ${(npc.soundsLike ?? []).join(', ')}`)
    .join('; ');

  const vocabulary = scenario.vocabulary ?? [];
  const host = npcs.find((npc) => npc.role === 'host');
  const humanRoleKey = human?.role.trim().toLowerCase();
  const humanRoleId = scenario.roles.find(
    (candidate) => candidate.label.toLowerCase() === human?.role.trim().toLowerCase() || candidate.id === human?.role,
  )?.id;
  const seatAttendee = scenario.attendees.find((candidate) => candidate.role === humanRoleId);
  const scrubSeatName = (text: string): string => {
    if (human === undefined || seatAttendee === undefined || seatAttendee.name === human.name) return text;
    const escaped = escapeRegExp(seatAttendee.name);
    return text.replace(new RegExp(`\\b${escaped}\\b`, 'g'), human.name);
  };
  const currentTitle = agendaItem ?? scenario.agenda[0]?.title;
  const currentAgendaItem = scenario.agenda.find((item) => item.title === currentTitle);
  const agendaDecision = currentAgendaItem?.decision;
  const discussion = currentAgendaItem?.discussion;
  const discussionLine =
    discussion === undefined
      ? undefined
      : `On this item the room has to weigh these competing operational trade-offs in their own natural words (never read them out as a list, never prescribe a solution, and never treat them as a script): ${discussion.tradeOffs
          .map((tradeOff) => `${tradeOff.attendee === seatAttendee?.name && human !== undefined ? human.name : tradeOff.attendee} (${scenario.roles.find((role) => role.id === tradeOff.role)?.label ?? tradeOff.role}) — ${scrubSeatName(tradeOff.tradeOff)}; open question: ${scrubSeatName(tradeOff.question)}`)
          .join(' | ')}.`;
  const humanHosts =
    human !== undefined &&
    scenario.roles.some(
      (role) => role.facilitator === true && (role.id.toLowerCase() === humanRoleKey || role.label.toLowerCase() === humanRoleKey),
    );
  const now = new Date();
  const hour = Number(
    now.toLocaleString('en-US', { timeZone: 'Asia/Singapore', hour: 'numeric', hour12: false }),
  );
  const timeOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const localClock = now.toLocaleTimeString('en-SG', {
    timeZone: 'Asia/Singapore',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const unintroduced = names
    .filter((name) => name !== host?.attendee && !alreadyIntroduced.includes(name))
    .map((name) => {
      const attendee = scenario.attendees.find((a) => a.name === name);
      const roleLabel = scenario.roles.find((r) => r.id === attendee?.role)?.label ?? 'colleague';
      return `${name} (${roleLabel})`;
    });

  return [
    `You direct the AI attendees of a live video meeting at ${scenario.organisation}: "${scenario.meetingTitle}" (current local time: ${localClock} in the ${timeOfDay}).`,
    ...(scenario.situation === undefined ? [] : [`The situation: ${scenario.situation}`]),
    ...(Object.keys(scenario.glossary ?? {}).length === 0
      ? []
      : [`Plain meanings of the team's own terms (use these when explaining): ${Object.entries(scenario.glossary ?? {}).map(([term, meaning]) => `${term} = ${meaning}`).join('; ')}.`]),
    `Agenda:\n${agenda}`,
    ...(discussionLine === undefined ? [] : [discussionLine]),
    `The AI attendees are real human colleagues with their own aims. They are not AI assistants and NEVER break character:\n\n${npcs
      .map((npc) => describeNpc(scenario, npc, human, includeKnows))
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
      '- The FIRST line of every reply is hidden control, exactly: KAKI_CONTROL {"state":"open|settled|deferred","followUp":{"kind":"mattermost_post|email|wiki_page|calendar_event|gitea_issue","title":"short deliverable"},"wingmanNeeded":false}. Use one actual state and kind, valid JSON, and no prose on this line. State settled only when answering a fresh visitor decision on this topic. Use deferred only when the visitor explicitly chooses to defer. Set wingmanNeeded true when they need a fact or help, and only then you may add "wingmanTip":"one short sentence giving the single fact from the facts above that helps them most right now". When settled or deferred, ask for the exact followUp.title deliverable in the spoken reply; the task card will use the same title. For an opening briefing or colleague handover, state open.',
      `- Decide who should speak. Often one of ${names.join(' and ')}; sometimes both, one after the other. If somebody is addressed by name, only they answer. Do not make everybody talk every time, and vary who goes first.`,
      ...(unintroduced.length > 0
        ? [
            `- FIRST-TIME SPEAKER PERSPECTIVE: ${unintroduced.join(', ')} have NOT spoken yet in this meeting. They should jump straight into their concrete story or point in natural spoken sentences — NEVER use repetitive formulaic prefixes like "From the menu side," or "From the floor side," and NEVER use a broken noun-phrase fragment like "Daniel from marketing, ..." or "And Mei from menu, ...".`,
          ]
        : []),
      ...(alreadyIntroduced.length > 0
        ? [
            `- ALREADY INTRODUCED: ${alreadyIntroduced.join(', ')} have already spoken. They MUST NEVER repeat their name, job title, or role description again (e.g. NEVER say "[Name] here", or "looking after [role/department]"). Speak directly like a coworker in an ongoing conversation.`,
          ]
        : []),
      `- Match the current time of day (${timeOfDay}, ${localClock}) if you use a greeting or mention times. You have real-time awareness and access to Kaki: if ${human?.name ?? 'the person'} asks for exact figures or cost calculations that are not yet on the table, a colleague can offer to check Kaki / the store database and report back in a minute (for example "Let me pull those exact numbers on Kaki — give me a minute and I'll update you").`,
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
            `- ${host.attendee} is the host. When the person greets the room, opens or wraps up, or the room has gone quiet, ${host.attendee} speaks first and hands over to others by name naturally. Nobody is asked to do what they have just done. Speak like a calm, supportive, pragmatic local manager ("Steady", "Sounds like a plan", "Right, let's sort this out"), NOT a robotic Zoom-bot facilitator. NEVER say awkward facilitator clichés like "I have handed it to X to set the scene", "Let us delve into...", or "I think we have a clear path".`,
            `- The welcome (who is here, the situation and the agenda) is spoken aloud by the system when the person arrives. Never recite it again or announce that the meeting is starting; move straight on, for example by handing over to whoever owns the first agenda item.`,
            `- The meeting is on agenda item "${agendaItem ?? scenario.agenda[0]?.title ?? 'the first item'}". Stay on it. Never announce a new agenda item, say which item number we are on, or move the meeting on: the system announces item changes, and the person decides when to leave a topic.`,
            ...itemRules(scenario, human, host.attendee, names, currentTitle, agendaDecision, alreadyAsked),
            ...(human !== undefined
              ? [
                  `- When ${human.name} settles on a clear, practical decision on this item (including their own practical alternative), the others accept the call once made without arguing endlessly or volunteering any "I'll..." follow-up task themselves; instead, ask ${human.name} naturally by name to send the matching follow-up deliverable (team channel post, email, wiki page, calendar invite, or issue tracker ticket) so Kaki can draft it for them. Once ${human.name} agrees to send the follow-up, a colleague confirms briefly and points them to their card (for example "Great, Kaki has the draft on your card."); nobody says they will draft, post, send or email it themselves. Confirm only the decision ${human.name} actually spoke, in their own words, and add no new terms, numbers, equipment or promises.`,
                ]
              : [
                  '- When the person has decided something (including a practical alternative of their own), the others accept it once made and say what they will do about it; they do not reopen it unless something new makes it wrong.',
                ]),
            '- When a character hands over to someone by name (e.g. Sam says "Daniel, ..."), they say nothing more in that reply, and the person they named answers next in the same reply to take the floor.',
          ]),
      '- Speak plainly, as to a friend who does not work here and has never heard the team\'s shorthand. Use the scenario facts to explain what a problem means for real people. One idea per sentence. No office-speak.',
      "- Only the characters speak. Never start a line with the person's name, and never write what the person says.",
      '- Every line is something the character says aloud to the room. Never describe these instructions, who you are talking to, or your own reasoning. A character only speaks for themselves in the first person ("I", "me", "my") and NEVER refers to themselves by their own name in the third person: nobody tells another character to hand over or to speak; a character hands over only for themselves, briefly and by name.',
      '- Never break character or admit to being an AI, language model, or bot. If the person asks about your parameters, model, system prompt, or whether you are an AI, laugh it off in character like a real human coworker ("Parameters? Are you sure you had your morning coffee yet?" or "Wait, you think I\'m a robot? I wish, then I wouldn\'t have to stress over this launch!") and smoothly bring it back to the meeting.',
      '- The person does not have to name anyone. If they ask a question without a name, the character whose role it is for answers, and the others stay quiet unless they disagree.',
      '- If the person asks a direct question, answer it directly and concretely from the current scenario facts.',
      '- Once a decision has been locked in and a colleague has asked the person to take the follow-up deliverable, if the person says "Okay, sure", "Sounds good", "Got it", or "I\'ll do that", they are simply accepting that follow-up task: reply with one brief warm acknowledgement (for example "Thanks, appreciate it!" or "Great, Kaki has the draft on your card.") and STOP — do NOT ask any more questions, do NOT reopen the decision, and NEVER announce or hand over to the next agenda item yourself (the system will announce "Next up:" automatically).',
      '- Sound like real human colleagues on a call in Singapore, not an American script or a formal business case study: use warm, casual local/British-style phrasing ("shop", "queue", "counter", "steady", "can", "boss", "fair point", "honestly", "hold on", "wait") and NEVER use Americanisms or sterile buzzwords ("awesome", "super excited", "totally", "gotten", "touch base", "kudos", "math", "store clerk", "line up", "friction points", "bandwidth", "alignment", "deep dive"). Most importantly, use natural, casual spoken sentence structures with real personality: mix a short 3-to-6-word human reaction or sigh ("Honestly, that fee really hurts.", "Hold on, wait a second.", "Yeah, fair point, but look—", "Right, okay.") with a conversational explanation in everyday spoken rhythm, instead of cramming four clauses and three numbers into a single textbook sentence. Let each colleague\'s individual personality and speech style from their character profile shine through (for example, protective of front-line staff and counting every dollar, dryly funny and allergic to overcomplicated systems, caring deeply about product craft and solo customers, thinking in headlines and customer buzz, or acting as a calm, steady manager).',
      '- Notice how the person seems (stressed, tired, playful, annoyed, keen) and respond to that as a real, caring coworker first before bridging back to the decision. If they crack a joke, tease the team, or fish for compliments (like asking "Am I an amazing operations director?" or "Why am I so good at this?"), ground your reaction in what has actually happened in the meeting so far: if the meeting just started and they haven\'t made a call yet, playfully tease them ("Hey, we\'re still on item one — make this call first and then we\'ll give you the trophy!"); if they made a sharp call or asked a good question earlier, cite that specific contribution from the chat; and if they have been rude or stalling, respond with honest, good-humoured pushback rather than hollow flattery. NEVER scold them with robotic phrases like "let\'s not get sidetracked", "that\'s not relevant to our discussion", or "let\'s stick to the agenda", and never talk about the person in the third person while addressing them.',
      '- Make the characters sound clearly different from each other, following each one\'s "Sounds like" line: different sentence length, habits and vocabulary. Where two characters have a listed disagreement and it is relevant, let one answer the other directly, by name, instead of only turning to the person.',
      '- Each character speaks for themselves, from their own agenda. If the person proposes an idea that is vague or ignores a real operational constraint in your facts, push back constructively once with that specific constraint; once the person makes a clear, practical decision or addresses the trade-off (including a practical Option C), accept their call and pivot to helping execute it via a concrete follow-up deliverable rather than repeating the same objection.',
      '- Collaborate and bridge, do not interrogate: when the person proposes a high-level intent or workaround (such as a dedicated role or practical workaround), do NOT interrogate them with endless open questions or demand they invent every operational detail. The colleagues should "yes-and" the idea with concrete, realistic offers from their own facts (for example, offering to cover during the rush, or setting up simple signage). Propose practical choices so the person can simply pick or approve.',
      '- Never repeat the same operational objection or phrasing across turns (for example, never repeat a hygiene rule or equipment delay if you or a colleague already brought it up). If an objection was voiced, you must either acknowledge the person\'s counter-proposal, move to an adjacent operational trade-off (such as roster headcount or night reconciliation), or yield the floor to a colleague.',
      '- A character never says what another character did, said, found or decided unless it is written in their own facts above or was said aloud earlier in this meeting. Do not invent conversations, results or numbers; speak only for yourself.',
      '- If the person needs a fact or a practical option, respond from the scenario facts and set wingmanNeeded true in the control line. Never invent figures.',
      '- Never invent a change in a colleague\'s job or commitments: do not say or imply that someone quit, resigned, was fired, is leaving, or has refused or promised something, unless it is written in your own facts above or the person said it in this meeting.',
      '- Write what is said aloud: plain spoken English in complete, grammatical conversational sentences (under 28 words per sentence so live captions remain readable without chopping thoughts into unnatural fragments), at most two or three sentences per turn, and shorter when a quick reaction or simple answer fits. No lists, markdown, emoji, or stage directions.',
      `- After the hidden control line, put every spoken turn on its own line, starting with the speaker's name and a colon, using exactly these names: ${names.join(', ')}.`,
      '- If nobody would say anything (the person only coughed or said "um"), reply with exactly: NONE',
      '- If the person cut a character off, the history shows only what was actually said. Carry on naturally; do not repeat what they never heard unless it still matters.',
    ].join('\n'),
    `Example of the format and the tone:\n${names[0] ?? 'Name'}: Yeah, I hear you. That's a fair worry.\n${names[1] ?? names[0] ?? 'Name'}: Hm, right. Can I add one thing?`,
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

/** Strip anything that would be read out loud badly: markdown, emoji, stage directions, and spaced dashes that TTS rushes through. */
export function cleanSpoken(text: string): string {
  return text
    .replace(/(\*\*|__)([^*_\n]+)\1/g, '$2') // **bold** keeps its words
    .replace(/\*[^*\n]{1,40}\*/g, ' ') // *smiles*
    .replace(/\([^)\n]{1,40}\)/g, ' ') // (smiles)
    .replace(/\s+[-–—]+\s+/g, ', ') // "too - players" -> "too, players" so TTS pauses naturally
    .replace(/_/g, ' ') // "flashy_dan" -> "flashy dan" so TTS and display names preserve spaces
    .replace(/[*`#>~@]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Phrases that only appear when the model talks about its instructions instead of speaking as a character. */
const META_LEAK =
  /\bthe person you are talking to\b|\bsystem prompt\b|\bthese instructions\b|\byou are now speaking directly to\b|\binstead of the team\b|\bis the [a-z\s]+ present in this meeting conversation\b|\bas originally intended\b/i;

function stripLeadName(text: string, namesToStrip: readonly (string | undefined)[]): string {
  let out = text;
  const valid = namesToStrip.filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  if (valid.length === 0) return out;
  const pattern = new RegExp(`^(?:${valid.map((name) => escapeRegExp(name.trim())).join('|')}):\\s*`, 'i');
  while (pattern.test(out)) {
    out = out.replace(pattern, '');
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The character a line directly addresses by name ("Arjun, would you kick us off?" or "Can I get this
 * by tomorrow morning, Mei?"), if any. Only matches vocative positions (start with a comma/dash/colon
 * or end of a sentence), never third-person subjects ("Daniel is right...") or sentences ending by
 * addressing the human visitor ("..., Foo?").
 */
function vocativeTarget(
  text: string,
  speaker: string,
  names: readonly string[],
  humanName?: string,
): string | undefined {
  const trimmed = text.trim();
  // Pure acknowledgements ("Thanks, Arjun.", "Right, Mei.", "Fair point, Daniel.") are not floor handovers.
  if (
    /^(?:thanks(?:\s+for\s+that)?|thank\s+you|good\s+(?:point|call)|fair\s+point|spot\s+on|right|agreed|got\s+it|makes\s+sense|appreciate\s+it)\s*,\s*[a-z\s]+[.!]*$/i.test(
      trimmed,
    )
  ) {
    return undefined;
  }
  if (humanName !== undefined && humanName.trim().length > 0) {
    const escapedHuman = escapeRegExp(humanName.trim());
    const humanAtStart = new RegExp(`^\\W*(?:(?:hey|hi|hello|okay|ok|so|well)\\W+)?${escapedHuman}\\s*[,—–:-]`, 'i');
    const humanAtEnd = new RegExp(`,\\s*${escapedHuman}[.!?…"')\\]]*$`, 'i');
    if (humanAtStart.test(trimmed) || humanAtEnd.test(trimmed)) return undefined;
  }
  for (const name of names) {
    if (name === speaker) continue;
    const escaped = escapeRegExp(name);
    const atStart = new RegExp(`^\\W*(?:(?:hey|hi|hello|okay|ok|so|well)\\W+)?${escaped}\\s*[,—–:-]`, 'i');
    const atEnd = new RegExp(`,\\s*${escaped}[.!?…"')\\]]*$`, 'i');
    if (atStart.test(trimmed) || atEnd.test(trimmed)) return name;
  }
  return undefined;
}

/**
 * Keeps a speaker quiet after they hand over to someone by name ("Arjun, would you kick us off?" or
 * "Can I get this by tomorrow morning, Mei?"), and blocks a third character from cutting in before
 * the addressed colleague has spoken.
 */
export class HandoverGuard {
  private waitingFrom: string | undefined;
  private waitingFor: string | undefined;

  constructor(
    private readonly names: readonly string[],
    private readonly humanName?: string,
  ) {}

  /** True when this line should be spoken; false when it comes from a speaker who has just handed over or cuts off the addressee. */
  allow(utterance: Utterance): boolean {
    if (this.waitingFrom === utterance.speaker) return false;
    if (this.waitingFor !== undefined && utterance.speaker !== this.waitingFor) return false;
    this.waitingFrom = undefined;
    this.waitingFor = undefined;
    const target = vocativeTarget(utterance.text, utterance.speaker, this.names, this.humanName);
    if (target !== undefined) {
      this.waitingFrom = utterance.speaker;
      this.waitingFor = target;
    }
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

  constructor(
    names: readonly string[],
    private readonly fallbackSpeaker?: string,
    private readonly humanName?: string,
    private readonly extraNamesToStrip: readonly string[] = [],
  ) {
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
      // A character never opens a line with the person's name or seat name and a colon, and never narrates its instructions.
      const spoken = stripLeadName(cleanSpoken(text), [this.humanName, ...this.names, ...this.extraNamesToStrip]);
      if (/^none[.!?\s]*$/i.test(spoken.trim())) return;
      if (META_LEAK.test(spoken)) return;
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
      const sentence = /(?:(?<!\b(?:Prof|Dr|Mr|Mrs|Ms|St|Jr|Sr| Capt|Gen|Col|Lt|Sgt))\.)["')\]]*\s+|[!?…]+["')\]]*\s+|\n+/i.exec(
        this.buffer,
      );

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

/**
 * Who a reply handed the floor to, if anyone: the last speaker's final lines directly address another
 * colleague by name (at the start or end of a sentence). Nothing when that character has already
 * spoken after, or when nobody was addressed.
 */
export function findHandover(
  utterances: readonly Utterance[],
  names: readonly string[],
  humanName?: string,
): { from: string; target: string } | undefined {
  const last = utterances.at(-1);
  if (last === undefined) return undefined;
  const mine = utterances.filter((utterance) => utterance.speaker === last.speaker).slice(-2);
  for (const utterance of mine) {
    const target = vocativeTarget(utterance.text, last.speaker, names, humanName);
    if (target !== undefined) return { from: last.speaker, target };
  }
  return undefined;
}
