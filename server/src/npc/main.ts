// Must stay the first import: later modules read process.env as they load.
import '../env';
import { WebSocket } from 'ws';
import { startRunnerMeeting, type RunnerMeetingHandle } from './runnerForMeeting';
import { createServiceChannel } from './serviceChannel';

/** `npm run npc`: one process that follows the server's control channel and runs every open meeting. */

const log = (message: string): void => console.log(`[npc ${new Date().toISOString().slice(11, 23)}] ${message}`);
const logError = (message: string): void =>
  console.error(`[npc ${new Date().toISOString().slice(11, 23)}] ${message}`);

const kakiUrl = process.env.KAKI_URL || `http://localhost:${process.env.PORT ?? '3001'}`;
const serviceToken = process.env.KAKI_SERVICE_TOKEN?.trim();

interface MeetingOpened {
  type: 'MEETING_OPENED';
  meetingId: string;
  kind: 'real' | 'practice';
  roomName: string;
}

const meetings = new Map<string, RunnerMeetingHandle>();
const starting = new Map<string, Promise<void>>();

async function openMeeting(meeting: MeetingOpened): Promise<void> {
  if (meetings.has(meeting.meetingId) || starting.has(meeting.meetingId)) return;
  const start = (async () => {
    try {
      log(`opening meeting ${meeting.meetingId} (${meeting.kind}) in room ${meeting.roomName}`);
      const handle = await startRunnerMeeting({
        meetingId: meeting.meetingId,
        kind: meeting.kind,
        roomName: meeting.roomName,
        kakiUrl,
        ...(serviceToken === undefined || serviceToken === '' ? {} : { serviceToken }),
        log,
        logError,
      });
      meetings.set(meeting.meetingId, handle);
    } catch (error) {
      logError(`meeting ${meeting.meetingId} could not start: ${String(error)}`);
    } finally {
      starting.delete(meeting.meetingId);
    }
  })();
  starting.set(meeting.meetingId, start);
  await start;
}

async function closeMeeting(meetingId: string): Promise<void> {
  const handle = meetings.get(meetingId);
  if (handle === undefined) return;
  meetings.delete(meetingId);
  try {
    await handle.stop();
    log(`closed meeting ${meetingId}`);
  } catch (error) {
    logError(`meeting ${meetingId} did not close cleanly: ${String(error)}`);
  }
}

/** A reconnecting control socket starts from the server's list again, so drop the old set first. */
async function closeAll(): Promise<void> {
  await Promise.all([...meetings.keys()].map((meetingId) => closeMeeting(meetingId)));
}

const control = createServiceChannel({
  token: serviceToken,
  createSocket: () =>
    new WebSocket(
      `${kakiUrl.replace(/^http/, 'ws')}/ws?audience=service-control`,
      serviceToken === undefined || serviceToken === ''
        ? undefined
        : { headers: { authorization: `Bearer ${serviceToken}` } },
    ),
  log,
  logError,
  onOpen: (socket) => {
    void closeAll();
    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        logError('ignored a control message that was not JSON');
        return;
      }
      const candidate = message as { type?: unknown; meetingId?: unknown; kind?: unknown; roomName?: unknown };
      if (candidate.type === 'MEETING_OPENED') {
        if (
          typeof candidate.meetingId !== 'string' ||
          (candidate.kind !== 'real' && candidate.kind !== 'practice') ||
          typeof candidate.roomName !== 'string'
        ) {
          logError('ignored a malformed MEETING_OPENED');
          return;
        }
        void openMeeting(candidate as MeetingOpened);
        return;
      }
      if (candidate.type === 'MEETING_CLOSED') {
        if (typeof candidate.meetingId !== 'string') {
          logError('ignored a malformed MEETING_CLOSED');
          return;
        }
        void closeMeeting(candidate.meetingId);
      }
    });
  },
});
control.start();
log('ready: following the server control channel; every open meeting starts its own listener.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    control.stop();
    void closeAll().then(() => process.exit(0));
  });
}
