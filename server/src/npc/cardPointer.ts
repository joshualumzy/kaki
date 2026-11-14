import type { ActionKind } from '@kaki/shared';

function whoPrefix(name: string | undefined): string {
  return name === undefined || name.trim() === '' ? '' : `${name.trim()}, `;
}

/** The host's line when a follow-up lands on the visitor's card: the first pointer, then a brief reminder. */
export function visitorDispatchLine(name: string | undefined, count: number): string {
  const who = whoPrefix(name);
  return count === 1
    ? `${who}the follow-up's on your screen whenever you want to send it.`
    : `${who}the follow-up's still on your screen whenever you're ready.`;
}

/** The first pointer at the visitor's card on a topic, naming an invite when that is what the card holds. */
export function visitorCardPointerLine(name: string | undefined, kind?: ActionKind): string {
  if (kind === 'calendar_event') {
    return `${whoPrefix(name)}the invite's on your screen whenever you're ready to confirm it.`;
  }
  return visitorDispatchLine(name, 1);
}
