import { useState } from 'react';
import { failureText } from '../../net/failureText';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { Avatar, Card, Dialog } from '../../ui';
import { QrCode } from '../QrCode';
import { useRealRoom } from './realRoom';
import { distinctDisplayNames } from './people';

/**
 * The real meeting's bottom bar. Practice keeps its own controls: this bar is only ever rendered
 * for a real meeting, so a solo practice room never grows Invite, People or Off the record.
 */
export function RealMeetingBar({
  meetingId,
  meetingCode,
  mediaProblem,
  onMediaProblemCleared,
}: {
  meetingId: string;
  meetingCode?: string;
  /** A device failure the room reported, shown here instead of a floating banner over the tiles. */
  mediaProblem?: string;
  onMediaProblemCleared?(): void;
}) {
  const livekitRoom = useRoomContext();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const meeting = useRealRoom();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [origin] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin));

  if (meeting === null) return null;
  const { meetingState, send, isHost } = meeting;
  // An ended room is a calm final screen with its own actions; live controls and notices would compete.
  if (meetingState?.phase === 'ended' || meeting.endedWhileAway !== undefined) return null;
  // Before the owner starts the meeting, only Leave (and the owner's Invite) do anything.
  const waiting = meetingState?.waitingForOwner === true;
  const offTheRecord = meetingState?.offTheRecord !== null && meetingState?.offTheRecord !== undefined;
  const people = meetingState?.participants ?? [];
  const shownNames = distinctDisplayNames(people);
  const inviteUrl = `${origin}/m/${encodeURIComponent(meetingId)}${
    meetingCode === undefined || meetingCode === ''
      ? ''
      : `?code=${encodeURIComponent(meetingCode)}`
  }`;

  async function toggleMicrophone(): Promise<void> {
    if (localParticipant === undefined) return;
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
      setProblem(undefined);
      onMediaProblemCleared?.();
    } catch (error) {
      console.error('kaki web: the microphone change failed', error);
      setProblem(failureText('mic-blocked', { real: true }));
    }
  }

  async function toggleCamera(): Promise<void> {
    if (localParticipant === undefined) return;
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
      setProblem(undefined);
      onMediaProblemCleared?.();
    } catch (error) {
      console.error('kaki web: the camera change failed', error);
      setProblem(failureText('camera-blocked', { real: true }));
    }
  }

  async function copyInvite(): Promise<void> {
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error('no clipboard');
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
      setProblem('Could not copy the link. Select it and copy it yourself.');
    }
  }

  function leave(): void {
    void livekitRoom.disconnect().catch(() => undefined);
  }

  const shownProblem = problem ?? mediaProblem;
  return (
    <div className="kd-real-bar" role="toolbar" aria-label="Meeting controls">
      {shownProblem === undefined ? null : (
        <p className="kd-real-bar-problem" role="alert">
          {shownProblem}
        </p>
      )}
      <div className="kd-real-bar-row">
        <button
          type="button"
          className="kd-bar-btn"
          data-on={isMicrophoneEnabled}
          aria-pressed={isMicrophoneEnabled}
          disabled={waiting}
          onClick={() => void toggleMicrophone()}
        >
          {isMicrophoneEnabled ? 'Mic on' : 'Mic off'}
        </button>
        <button
          type="button"
          className="kd-bar-btn"
          data-on={isCameraEnabled}
          aria-pressed={isCameraEnabled}
          disabled={waiting}
          onClick={() => void toggleCamera()}
        >
          {isCameraEnabled ? 'Camera on' : 'Camera off'}
        </button>
        <button
          type="button"
          className="kd-bar-btn"
          data-on={offTheRecord}
          aria-pressed={offTheRecord}
          aria-describedby="kd-off-record-hint"
          title="Stop Kaki writing anything down until you resume"
          disabled={waiting}
          onClick={() => send({ type: 'SET_OFF_THE_RECORD', on: !offTheRecord })}
        >
          {offTheRecord ? 'Back on the record' : 'Off the record'}
        </button>
        <button
          type="button"
          className="kd-bar-btn"
          data-on={inviteOpen}
          aria-expanded={inviteOpen}
          disabled={waiting && !isHost}
          onClick={() => setInviteOpen((open) => !open)}
        >
          Invite
        </button>
        <button
          type="button"
          className="kd-bar-btn"
          data-on={peopleOpen}
          aria-expanded={peopleOpen}
          onClick={() => setPeopleOpen((open) => !open)}
        >
          People
          {people.length === 0 ? null : <span className="kd-bar-count">{people.length}</span>}
        </button>
        <button type="button" className="kd-bar-btn" data-tone="leave" onClick={leave}>
          Leave
        </button>
        {isHost ? (
          <button
            type="button"
            className="kd-bar-btn"
            data-tone="danger"
            onClick={() => setConfirmEnd(true)}
          >
            End for everyone
          </button>
        ) : null}
      </div>
      <p className="kd-bar-hint" id="kd-off-record-hint">
        Off the record pauses all notes until you resume.
      </p>

      {inviteOpen ? (
        <div className="kd-real-pop" role="dialog" aria-label="Invite people">
          <p className="kd-label">Invite link</p>
          <p className="kd-real-link">
            <a href={inviteUrl}>{inviteUrl}</a>
          </p>
          <div className="kd-real-pop-actions">
            <button type="button" className="kd-chip" onClick={() => void copyInvite()}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
            {meetingCode === undefined || meetingCode === '' ? null : (
              <span>
                Meeting code: <strong>{meetingCode}</strong>
              </span>
            )}
          </div>
          <div className="kd-real-qr">
            <QrCode value={inviteUrl} label="the meeting" />
            <p className="kd-hint">Scan to join on a phone.</p>
          </div>
        </div>
      ) : null}

      {peopleOpen ? (
        <div className="kd-real-pop" role="dialog" aria-label="People in the meeting">
          <p className="kd-label">In the room</p>
          {people.length === 0 ? (
            <p className="kd-hint">No one has joined yet.</p>
          ) : (
            <ul className="kd-real-people">
              {people.map((person) => (
                <li key={`${person.name}-${person.seat}`}>
                  <Avatar name={shownNames.get(person.seat) ?? person.name} photoUrl={person.photoUrl} size="sm" />
                  <span>{shownNames.get(person.seat) ?? person.name}</span>
                  {person.seat === meeting.role ? (
                    <small>· You</small>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <Dialog
        open={confirmEnd && isHost}
        onClose={() => setConfirmEnd(false)}
        label="End the meeting for everyone"
      >
        <Card title="End for everyone?">
          <p className="kd-hint">
            This ends the meeting for every person and freezes its minutes. It cannot be undone.
          </p>
          <div className="kd-real-pop-actions">
            <button
              type="button"
              className="kd-chip"
              data-tone="danger"
              onClick={() => {
                const sent = send({ type: 'END_MEETING' });
                setConfirmEnd(false);
                if (!sent) {
                  setProblem("Couldn't end the meeting: the room is reconnecting. Try again in a moment.");
                }
              }}
            >
              End the meeting
            </button>
            <button type="button" className="kd-chip" onClick={() => setConfirmEnd(false)}>
              Cancel
            </button>
          </div>
        </Card>
      </Dialog>
    </div>
  );
}
