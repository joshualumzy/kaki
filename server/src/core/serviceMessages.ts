import type { RawData } from 'ws';

/** A server-owned request asking the AI runner to prepare the meeting before Start commits. */
export interface RunnerStartRequest {
  /** Unique for this Start attempt; the runner echoes it back with the meeting id. */
  requestId: string;
  /** The same id as `requestId`, carried under the name the Start protocol uses. */
  attempt: string;
  /** The meeting this attempt belongs to; an acknowledgement for any other meeting is ignored. */
  meetingId: string;
  startedAt: string;
  agendaIndex: number;
  /** True when this is a saved meeting being resumed after a restart, not a fresh opening. */
  resumed: boolean;
}

/** A message the AI runner sends back over the service channel. */
export type ServiceMessage =
  | { kind: 'ready'; requestId: string; attempt: string; meetingId: string }
  | { kind: 'failed'; requestId: string; attempt: string; meetingId: string; reason?: string };

export function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8');
  return data.toString('utf8');
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function parseServiceMessage(value: unknown): ServiceMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as {
    kind?: unknown;
    requestId?: unknown;
    attempt?: unknown;
    meetingId?: unknown;
    reason?: unknown;
  };
  if (!nonEmptyString(message.requestId) || !nonEmptyString(message.attempt) || !nonEmptyString(message.meetingId)) {
    return undefined;
  }
  if (message.kind === 'ready') {
    return { kind: 'ready', requestId: message.requestId, attempt: message.attempt, meetingId: message.meetingId };
  }
  if (message.kind === 'failed') {
    return {
      kind: 'failed',
      requestId: message.requestId,
      attempt: message.attempt,
      meetingId: message.meetingId,
      ...(typeof message.reason === 'string' ? { reason: message.reason } : {}),
    };
  }
  return undefined;
}
