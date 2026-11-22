import { useState } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { Avatar } from '../../ui';
import { QrCode } from '../MeetingOverlays';
import { newClientLineId } from './stageModel';
import { useRealRoom } from './realRoom';
import { distinctDisplayNames } from './people';

/**
 * The real meeting's bottom bar. Practice keeps its own controls: this bar is only ever rendered
 * for a real meeting, so a solo practice room never grows Invite, People or Off the record.
 */
export function RealMeetingBar({
  meetingId,
  meetingCode,
}: {
  meetingId: string;
  meetingCode?: string;
}) {
  const livekitRoom = useRoomContext();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const meeting = useRealRoom();
  const [typeOpen, setTypeOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [origin] = useState(() => (typeof window === 'undefined' ? '' : window.location.origin));

  if (meeting === null) return null;
  const { meetingState, send, isHost } = meeting;
  const ended = meetingState?.phase === 'ended';
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
    } catch {
      setProblem('Could not change your microphone. Check the browser permission.');
    }
  }

  async function toggleCamera(): Promise<void> {
    if (localParticipant === undefined) return;
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
    } catch {
      setProblem('Could not change your camera. Check the browser permission.');
    }
  }

  function submitTyped(): void {
    const text = typed.trim();
    if (text === '') return;
    const sent = send({
      type: 'HUMAN_LINE',
      text,
      source: 'typed',
      clientLineId: newClientLineId(),
    });
    if (sent) {
      setTyped('');
      setProblem(undefined);
      return;
    }
    setProblem("Couldn't send your line. Check your connection and try again.");
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

  return (
    <div className="kd-real-bar" role="toolbar" aria-label="Meeting controls">
      {problem === undefined ? null : (
        <p className="kd-real-bar-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="kd-real-bar-row">
        {ended ? null : (
          <>
            <button
              type="button"
              className="kd-bar-btn"
              data-on={isMicrophoneEnabled}
              aria-pressed={isMicrophoneEnabled}
              onClick={() => void toggleMicrophone()}
            >
              {isMicrophoneEnabled ? 'Mic on' : 'Mic off'}
            </button>
            <button
              type="button"
              className="kd-bar-btn"
              data-on={isCameraEnabled}
              aria-pressed={isCameraEnabled}
              onClick={() => void toggleCamera()}
            >
              {isCameraEnabled ? 'Camera on' : 'Camera off'}
            </button>
            <button
              type="button"
              className="kd-bar-btn"
              data-on={typeOpen}
              aria-expanded={typeOpen}
              onClick={() => setTypeOpen((open) => !open)}
            >
              Type
            </button>
            <button
              type="button"
              className="kd-bar-btn"
              data-on={offTheRecord}
              aria-pressed={offTheRecord}
              onClick={() => send({ type: 'SET_OFF_THE_RECORD', on: !offTheRecord })}
            >
              {offTheRecord ? 'Back on the record' : 'Off the record'}
            </button>
            <button
              type="button"
              className="kd-bar-btn"
              data-on={inviteOpen}
              aria-expanded={inviteOpen}
              onClick={() => setInviteOpen((open) => !open)}
            >
              Invite
            </button>
          </>
        )}
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
        {isHost && !ended ? (
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

      {typeOpen && !ended ? (
        <form
          className="kd-real-type"
          onSubmit={(event) => {
            event.preventDefault();
            submitTyped();
          }}
        >
          <input
            aria-label="Type to the meeting"
            value={typed}
            autoFocus
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Type to speak, press Enter"
          />
          <button type="submit" className="kd-bar-btn" data-on disabled={typed.trim() === ''}>
            Send
          </button>
        </form>
      ) : null}

      {inviteOpen && !ended ? (
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

      {confirmEnd && isHost && !ended ? (
        <div className="kd-real-pop" role="dialog" aria-label="End the meeting for everyone">
          <p className="kd-label">End for everyone?</p>
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
        </div>
      ) : null}
    </div>
  );
}
