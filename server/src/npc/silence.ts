/**
 * What the room says when the person at the head of the table has gone quiet.
 *
 * Stage 1 is the host checking in with the person by name, with no rush and no recap. Stage 2 is the
 * topic's owner offering one thought that helps them get unstuck. Neither ever hands the person a
 * menu to pick from: the call is theirs to make in their own words.
 */

/** The host's spoken check-in when no model is available; `seed` varies the wording by topic. */
export function silenceCheckInLine(name: string, spokenTopic: string, seed: number): string {
  const lines: ReadonlyArray<(who: string, topic: string) => string> = [
    (who, topic) => `${who}, no rush. What's your gut on ${topic}?`,
    (who, topic) => `${who}, take your time. What's your instinct on ${topic}?`,
    (who, topic) => `${who}, no rush at all. What feels right to you on ${topic}?`,
    (who, topic) => `${who}, whenever you're ready. What's your first thought on ${topic}?`,
    (who, topic) => `${who}, we're in no hurry. What would you lean towards on ${topic}?`,
  ];
  return lines[Math.abs(Math.trunc(seed)) % lines.length]!(name, spokenTopic);
}

/** The note the host writes the stage 1 check-in from. */
export function silenceCheckInNote(
  host: string,
  guest: string,
  spokenTopic: string,
  settled: boolean,
): string {
  const ask = settled
    ? `whether they are happy with the plan the room just agreed and ready to move on`
    : `what their gut says about ${spokenTopic}`;
  return `[${guest} is taking a moment to think on "${spokenTopic}". Begin your reply with "${host}:". ${host} checks in with ${guest} in one short, warm, spoken sentence, with no rush, asking ${ask}. Use only facts and names already heard in this room; never add a new open item, task, person or number, never mention a card or screen, and never volunteer to do any work yourself. Do not offer a recap, a menu or a shortlist, and do not mention this note.]`;
}

/** The note the topic's owner writes their one helpful line from at stage 2. */
export function silenceColleagueNote(
  owner: string,
  guest: string,
  title: string,
  decision: string | undefined,
): string {
  const decisionText = decision === undefined ? '' : ` (${decision})`;
  return `[${guest} is still thinking on "${title}"${decisionText}. Begin your reply with "${owner}:". ${owner} says ONE short spoken sentence that helps ${guest} get unstuck: name what matters most to ${owner} here, or ask a smaller concrete question tied to the last thing said. Use only facts and names already heard in this room; never add a new open item, task, person or number, never mention a card or screen, and do not take on ${guest}'s follow-up yourself. Never give ${guest} a menu or a shortlist, never solve it for them, and wait for ${guest}'s answer. Do not mention this note.]`;
}
