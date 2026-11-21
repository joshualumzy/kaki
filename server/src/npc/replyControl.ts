import { ACTION_KINDS, type ActionKind } from '@kaki/shared';

/** State a reply line can set: open, settled or deferred, plus any card, tip or reactions it carries. */
export interface ReplyControl {
  state: 'open' | 'settled' | 'deferred';
  followUp?: { kind: ActionKind; title: string };
  wingmanNeeded: boolean;
  /** One fact that helps the visitor right now, shown on their Wingman; never spoken. */
  wingmanTip?: string;
  newFacts?: string[];
  reactions?: Array<{ who: string; emoji: ReactionEmoji }>;
  reopen?: string;
}

const REACTION_EMOJIS = ['👍', '😬', '🤔', '😅', '🙌', '💸', '🤨', '⏰'] as const;
type ReactionEmoji = typeof REACTION_EMOJIS[number];

/** The control an ordinary reply starts with: open, with no Wingman needed. */
export const OPEN_REPLY_CONTROL: ReplyControl = { state: 'open', wingmanNeeded: false };
const CONTROL_HEADER = /^KAKI_CONTROL(?:\s+|$)/u;

/** True when the trimmed line begins with the control header. */
export function isReplyControlLine(line: string): boolean {
  return CONTROL_HEADER.test(line.trimStart());
}

/** True when the line is a prefix of the control header, so a partial first line is not spoken. */
export function couldBeReplyControlLine(line: string): boolean {
  const head = line.trimStart();
  return 'KAKI_CONTROL'.startsWith(head) || isReplyControlLine(head);
}

/** Only a valid first line can change topic state. Every other line is speech. */
export function parseReplyControl(line: string, log: (message: string) => void = console.error): ReplyControl | undefined {
  const header = CONTROL_HEADER.exec(line.trimStart());
  if (header === null) return undefined;
  try {
    const value: unknown = JSON.parse(line.trimStart().slice(header[0].length));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const data = value as Record<string, unknown>;
    if (data.state !== 'open' && data.state !== 'settled' && data.state !== 'deferred') return undefined;
    if (typeof data.wingmanNeeded !== 'boolean') return undefined;
    let followUp: ReplyControl['followUp'];
    if (data.followUp !== undefined) {
      if (typeof data.followUp !== 'object' || data.followUp === null || Array.isArray(data.followUp)) return undefined;
      const proposed = data.followUp as Record<string, unknown>;
      if (!ACTION_KINDS.includes(proposed.kind as ActionKind) ||
          typeof proposed.title !== 'string' || proposed.title.trim().length === 0) return undefined;
      followUp = { kind: proposed.kind as ActionKind, title: proposed.title.trim() };
    }
    const wingmanTip = typeof data.wingmanTip === 'string' && data.wingmanTip.trim().length > 0 ? data.wingmanTip.trim() : undefined;
    let newFacts: string[] | undefined;
    if (data.newFacts !== undefined) {
      if (Array.isArray(data.newFacts) && data.newFacts.length <= 2 && data.newFacts.every((fact) =>
        typeof fact === 'string' && fact.trim().length > 0 && fact.trim().length <= 160)) {
        newFacts = data.newFacts.map((fact: string) => fact.trim());
      } else log('[control] dropped newFacts: expected up to two nonempty strings of at most 160 characters');
    }
    let reactions: ReplyControl['reactions'];
    if (data.reactions !== undefined) {
      if (Array.isArray(data.reactions) && data.reactions.length <= 2 && data.reactions.every((reaction) =>
        typeof reaction === 'object' && reaction !== null && !Array.isArray(reaction) &&
        typeof reaction.who === 'string' && reaction.who.trim().length > 0 &&
        (REACTION_EMOJIS as readonly unknown[]).includes(reaction.emoji))) {
        reactions = data.reactions.map((reaction: { who: string; emoji: ReactionEmoji }) => ({ who: reaction.who.trim(), emoji: reaction.emoji }));
      } else log('[control] dropped reactions: expected up to two named colleagues and allowed emoji');
    }
    let reopen: string | undefined;
    if (data.reopen !== undefined) {
      if (typeof data.reopen === 'string' && data.reopen.trim().length > 0 && data.reopen.length <= 160) reopen = data.reopen.trim();
      else log('[control] dropped reopen: expected an agenda title');
    }
    return {
      state: data.state,
      wingmanNeeded: data.wingmanNeeded,
      ...(followUp === undefined ? {} : { followUp }),
      ...(wingmanTip === undefined ? {} : { wingmanTip }),
      ...(newFacts === undefined ? {} : { newFacts }),
      ...(reactions === undefined ? {} : { reactions }),
      ...(reopen === undefined ? {} : { reopen }),
    };
  } catch {
    return undefined;
  }
}
