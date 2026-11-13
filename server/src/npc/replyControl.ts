import { ACTION_KINDS, type ActionKind } from '@kaki/shared';

export interface ReplyControl {
  state: 'open' | 'settled' | 'deferred';
  followUp?: { kind: ActionKind; title: string };
  wingmanNeeded: boolean;
  /** One fact that helps the visitor right now, shown on their Wingman; never spoken. */
  wingmanTip?: string;
}

export const OPEN_REPLY_CONTROL: ReplyControl = { state: 'open', wingmanNeeded: false };
const CONTROL_HEADER = /^KAKI_CONTROL(?:\s+|$)/u;

export function isReplyControlLine(line: string): boolean {
  return CONTROL_HEADER.test(line.trimStart());
}

export function couldBeReplyControlLine(line: string): boolean {
  const head = line.trimStart();
  return 'KAKI_CONTROL'.startsWith(head) || isReplyControlLine(head);
}

/** Only a valid first line can change topic state. Every other line is speech. */
export function parseReplyControl(line: string): ReplyControl | undefined {
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
    return {
      state: data.state,
      wingmanNeeded: data.wingmanNeeded,
      ...(followUp === undefined ? {} : { followUp }),
      ...(wingmanTip === undefined ? {} : { wingmanTip }),
    };
  } catch {
    return undefined;
  }
}
