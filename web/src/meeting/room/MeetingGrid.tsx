import { useEffect, useMemo, useState } from 'react';
import {
  ControlBar,
  GridLayout,
  RoomAudioRenderer,
  useDataChannel,
  useLocalParticipant,
  useParticipants,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import {
  isKakiListener,
  NPC_STATE_TOPIC,
  parseSpeechStatusMessage,
  roleLabel,
  SPEECH_STATUS_TOPIC,
  type NpcStateMessage,
  type SpeechStatusMessage,
} from '@kaki/shared';
import { useKaki, useScenario } from '../../kaki';
import { failureText } from '../../net/failureText';
import { CaptionedTile, PendingTile, StageContext } from './CaptionedTile';
import { RealMeetingBar } from './RealMeetingBar';
import { RealRoomBanners, RealWaitingOverlay } from './RealRoomOverlays';
import { MutedHint } from './MutedHint';
import { useRealRoom } from './realRoom';
import { distinctDisplayNames, peopleNotInRoom } from './people';
import { SectionIcon } from './SectionHeading';
import { activeStageTaskFor, tracksWithSpeakerFirst, visibleStageTracks } from './stageModel';
import { textOnlyNote, transcriptChunks } from './captions';

/** The meeting stage: one tile per participant with live captions, and the AI attendees' status. */
export function MeetingGrid({
  role,
  onOpenKaki,
  onKakiBadgeChange,
  sharedAudience = 'screen',
  real = false,
  meetingId,
  meetingCode,
  mediaProblem,
  onMediaProblemCleared,
}: {
  role: string;
  onOpenKaki?: () => void;
  onKakiBadgeChange?: (count: number) => void;
  /** A team participant reads the seat-bound projection; the owner and practice keep the screen. */
  sharedAudience?: 'screen' | 'participant';
  /** A real meeting replaces the practice controls with its own bottom bar. */
  real?: boolean;
  meetingId?: string;
  meetingCode?: string;
  /** A device failure reported by the room, shown once in the real meeting's bar. */
  mediaProblem?: string;
  onMediaProblemCleared?(): void;
}) {
  const scenario = useScenario();
  const realRoom = useRealRoom();
  const meetingState = realRoom?.meetingState;
  const offTheRecord = real && meetingState?.offTheRecord !== null && meetingState?.offTheRecord !== undefined;
  const { localParticipant } = useLocalParticipant();
  const { events, wingmanNotes } = useKaki({ kind: 'role', role });
  const { events: screenEvents, latestRecord, speechByTopic, tasks: screenTasks } = useKaki(sharedAudience === 'participant' ? { kind: 'participant' } : { kind: 'screen' });
  const participants = useParticipants().filter((participant) => !isKakiListener(participant.identity));
  // A real meeting lists everyone the server seated, even before their LiveKit connection arrives.
  const pendingPeople = useMemo(
    () => (real && meetingState?.phase !== 'ended' ? peopleNotInRoom(meetingState?.participants ?? [], participants) : []),
    [real, meetingState?.phase, meetingState?.participants, participants],
  );
  const tracks = visibleStageTracks(
    useTracks(
      [
        { source: Track.Source.Camera, withPlaceholder: true },
        { source: Track.Source.ScreenShare, withPlaceholder: false },
      ],
      { onlySubscribed: false },
    ),
    scenario,
  );

  // Captions fade by the clock, so the stage re-renders twice a second.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, []);

  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 700px)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 700px)');
    const update = (): void => setNarrow(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  const [npcState, setNpcState] = useState<NpcStateMessage>({ kind: 'idle' });
  useDataChannel(NPC_STATE_TOPIC, (message) => {
    try {
      setNpcState(JSON.parse(new TextDecoder().decode(message.payload)) as NpcStateMessage);
    } catch {
      // not a message from the AI attendees
    }
  });

  const [speechStatus, setSpeechStatus] = useState<SpeechStatusMessage>({ participants: {} });
  useDataChannel(SPEECH_STATUS_TOPIC, (message) => {
    try {
      const parsed = parseSpeechStatusMessage(JSON.parse(new TextDecoder().decode(message.payload)));
      if (parsed !== undefined) setSpeechStatus(parsed);
    } catch {
      // not a speech-status message
    }
  });

  const aiNames = useMemo(() => new Set((scenario.npcs ?? []).map((npc) => npc.attendee)), [scenario]);
  const aiPresent = participants.some((participant) => aiNames.has(participant.identity));
  const speechRecording = useMemo(() => {
    for (let index = screenEvents.length - 1; index >= 0; index -= 1) {
      const event = screenEvents[index]!;
      if (event.type === 'SPEECH_RECORDING') return event.payload.recording;
    }
    return undefined;
  }, [screenEvents]);
  const ownIdentity = localParticipant?.identity;
  const ownSpeechFailure =
    ownIdentity === undefined ? undefined : speechStatus.participants[ownIdentity]?.state === 'failed'
      ? speechStatus.participants[ownIdentity]
      : undefined;
  const speechNotice = useMemo(() => {
    if (speechStatus.outage !== undefined) {
      return {
        // The raw reason is part of the key, so a new outage reason announces again.
        key: `outage:${speechStatus.outage.code}:${speechStatus.outage.reason ?? ''}`,
        text: failureText(speechStatus.outage.code, {
          real,
          ownSpeechFailed: ownSpeechFailure !== undefined,
        }),
      };
    }
    if (ownSpeechFailure !== undefined) {
      return {
        key: `failed:${ownSpeechFailure.code ?? 'speech-failed'}`,
        text: failureText(ownSpeechFailure.code ?? 'speech-failed', { real }),
      };
    }
    return undefined;
  }, [speechStatus.outage, ownSpeechFailure, real]);
  const chunks = useMemo(() => (offTheRecord ? [] : transcriptChunks(events)), [events, offTheRecord]);
  const voiceNote = offTheRecord ? null : textOnlyNote(chunks, now);
  const avatars = useMemo(() => {
    const map = new Map<string, { displayName: string; photoUrl: string | null }>();
    const people = meetingState?.participants ?? [];
    const shown = distinctDisplayNames(people);
    const entryFor = (person: (typeof people)[number]) => ({
      displayName: shown.get(person.seat) ?? (person.displayName || person.name),
      photoUrl: person.photoUrl,
    });
    // Seats go in last: a seat is unique, a name can be shared by two people.
    for (const person of people) map.set(person.name.trim().toLowerCase(), entryFor(person));
    for (const person of people) map.set(person.seat.trim().toLowerCase(), entryFor(person));
    return map;
  }, [meetingState?.participants]);
  const facilitatorName = useMemo(() => {
    const hostRole = scenario.roles.find((r) => r.facilitator === true);
    if (hostRole === undefined) return 'the host';
    return scenario.attendees.find((a) => a.role === hostRole.id)?.name ?? roleLabel(scenario, hostRole.id);
  }, [scenario]);
  const facilitatorRole = useMemo(
    () => scenario.roles.find((role) => role.facilitator === true)?.id,
    [scenario.roles],
  );
  const activeAgendaIndex = latestRecord?.payload.agendaIndex ?? 0;

  // Who spoke is recorded by the hook as each line arrives, so it survives the record leaving the
  // 50-event window. Exact seats come from speakerRole; names only for older lines without one.
  const hasColleagueBriefed = useMemo(() => {
    const speech = speechByTopic.get(activeAgendaIndex);
    if (speech === undefined) return false;
    for (const speakerRole of speech.roles) {
      if (speakerRole !== facilitatorRole) return true;
    }
    const facilitator = facilitatorName.toLowerCase();
    for (const speaker of speech.names) {
      if (!speaker.startsWith(facilitator)) return true;
    }
    return false;
  }, [speechByTopic, facilitatorRole, facilitatorName, activeAgendaIndex]);
  const waitingForHuman =
    npcState.kind === 'idle' && npcState.yourTurn !== undefined && hasColleagueBriefed;

  const activeItem = scenario.agenda[activeAgendaIndex];
  const activeOwnerRole = activeItem?.ownerRole ?? role;
  const stage = useMemo(
    () => ({
      scenario, chunks, events, now, npcState, speechStatus, waitingForHuman,
      activeItemOwnerRole: activeOwnerRole, activeAgendaIndex, avatars, offTheRecord, real,
    }),
    [scenario, chunks, events, now, npcState, speechStatus, waitingForHuman, activeOwnerRole, activeAgendaIndex, avatars, offTheRecord, real],
  );

  const [dismissedToastKey, setDismissedToastKey] = useState<string>('');
  const actionableMyTasksCount = useMemo(() => {
    const allTasks = [...screenTasks.values()];
    return allTasks.filter(
      (t) =>
        (t.assignee ?? t.suggestedAssignee) === role &&
        (t.status === 'DISPATCHED' || t.status === 'DRAFT_READY'),
    ).length;
  }, [screenTasks, role]);

  useEffect(() => {
    onKakiBadgeChange?.(actionableMyTasksCount);
  }, [actionableMyTasksCount, onKakiBadgeChange]);

  // A direct question for this seat outranks any task pill, but a shared screen never sees it.
  const directQuestion = useMemo(() => {
    if (real && sharedAudience !== 'participant') return undefined;
    return [...wingmanNotes]
      .reverse()
      .find((note) => note.urgency === 'act_now' && note.clears !== true);
  }, [wingmanNotes, real, sharedAudience]);

  const activeStageToast = useMemo(() => {
    if (directQuestion !== undefined) {
      return {
        key: `question:${directQuestion.id}`,
        label: 'Kaki has a question for you · open in Kaki →',
        target: 'wingman',
        icon: 'ear' as const,
        tone: 'wingman' as const,
      };
    }
    const allTasks = [...screenTasks.values()];
    const myTask = activeStageTaskFor(allTasks, role, activeItem?.title);
    if (myTask !== undefined) {
      const key = `task:${myTask.id}:${myTask.status}`;
      return {
        key,
        label:
          myTask.status === 'DRAFT_READY'
            ? 'Draft ready · review in Kaki →'
            : 'A task needs you · open in Kaki →',
        target: 'needs-you-now',
        icon: 'action' as const,
        tone: 'action' as const,
      };
    }
    const publishedTask = [...allTasks]
      .reverse()
      .find((t) => (t.status === 'COMPLETED' || t.status === 'SYNCED') && t.artifactUrl !== undefined);
    if (publishedTask !== undefined) {
      const key = `published:${publishedTask.id}:${publishedTask.status}`;
      return {
        key,
        label: 'Published · open in Kaki →',
        target: 'action-board',
        icon: 'action' as const,
        tone: 'action' as const,
      };
    }
    return undefined;
  }, [directQuestion, screenTasks, role, activeItem]);

  // Open the panel first, then scroll once the section it holds has actually rendered.
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  useEffect(() => {
    if (pendingScroll === null) return;
    const scroll = (): void => {
      document.getElementById(pendingScroll)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      setPendingScroll(null);
    };
    const hasRaf = typeof window.requestAnimationFrame === 'function';
    const frame = hasRaf ? window.requestAnimationFrame(scroll) : window.setTimeout(scroll, 0);
    return () => {
      if (hasRaf) window.cancelAnimationFrame(frame);
      else window.clearTimeout(frame);
    };
  }, [pendingScroll]);

  const speakingSpeaker = npcState.kind === 'speaking' ? npcState.speaker : undefined;
  const gridTracks = useMemo(
    () => (narrow ? tracksWithSpeakerFirst(tracks, speakingSpeaker) : tracks),
    [narrow, tracks, speakingSpeaker],
  );
  const meetingWrappedUp = useMemo(
    () => screenEvents.some((event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING'),
    [screenEvents],
  );
  const topicSettled = useMemo(() => {
    const title = activeItem?.title;
    if (title === undefined) return false;
    return [...screenTasks.values()].some(
      (task) => task.agendaItemTitle === title && task.status !== 'SUGGESTED',
    );
  }, [screenTasks, activeItem]);
  const stageToastVisible =
    activeStageToast !== undefined &&
    activeStageToast.key !== dismissedToastKey &&
    !meetingWrappedUp &&
    (!topicSettled ||
      activeStageToast.key.startsWith('question:') ||
      activeStageToast.key.startsWith('task:') ||
      activeStageToast.key.startsWith('published:')) &&
    !(!narrow && activeStageToast.key.startsWith('task:') && actionableMyTasksCount > 0);

  return (
    <StageContext.Provider value={stage}>
      <div className="kd-stage-col">
        {real ? <RealRoomBanners /> : null}
        {!real && npcState.kind === 'error' && (
          <div role="alert" className="kd-banner" data-tone="error">
            The AI colleagues hit a problem: {npcState.message}
          </div>
        )}
        {!real && speechRecording === false && (
          <div role="alert" className="kd-banner" data-tone="error">
            Speech is not being recorded: the AI service is not connected. Start it with{' '}
            <code>npm run npc</code>.
          </div>
        )}
        {!offTheRecord && speechNotice !== undefined && (
          <div key={speechNotice.key} role="alert" className="kd-banner" data-tone="error">
            {speechNotice.text}
          </div>
        )}
        {!real && (scenario.npcs ?? []).length > 0 && !aiPresent && (
          <div className="kd-banner">
            Waiting for the AI colleagues. Start them with <code>npm run npc</code>.
          </div>
        )}
        {!offTheRecord && stageToastVisible && activeStageToast !== undefined && (
          <div
            className="kd-stage-toast"
            data-tone={activeStageToast.tone}
            role="status"
            aria-live="polite"
            onClick={() => {
              onOpenKaki?.();
              setPendingScroll(activeStageToast.target);
            }}
            style={{ cursor: 'pointer' }}
          >
            <SectionIcon name={activeStageToast.icon} className="kd-stage-toast-icon" />
            <span className="kd-stage-toast-text">{activeStageToast.label}</span>
            <button
              type="button"
              className="kd-stage-toast-close"
              aria-label="Dismiss notification"
              onClick={(event) => {
                event.stopPropagation();
                setDismissedToastKey(activeStageToast.key);
              }}
            >
              ✕
            </button>
          </div>
        )}
        <div className="kd-grid-wrap">
          <GridLayout tracks={gridTracks} style={{ height: '100%' }}>
            <CaptionedTile />
          </GridLayout>
          {real && meetingId !== undefined ? <RealWaitingOverlay meetingId={meetingId} /> : null}
        </div>
        {pendingPeople.length > 0 && (
          <div className="kd-pending-tiles" aria-label="Joining the meeting">
            {pendingPeople.map((person) => (
              <PendingTile key={person.seat} person={person} name={avatars.get(person.seat.trim().toLowerCase())?.displayName} />
            ))}
          </div>
        )}
        {voiceNote !== null && (
          <div className="kd-caption-note" role="status" aria-live="polite">
            {voiceNote}
          </div>
        )}
        {!real && waitingForHuman && !meetingWrappedUp && !topicSettled && (
          <p className="kd-turn-hint" role="status">Your turn — just speak</p>
        )}
        <MutedHint />
        {real ? (
          <RealMeetingBar
            meetingId={meetingId ?? ''}
            {...(meetingCode === undefined ? {} : { meetingCode })}
            {...(mediaProblem === undefined ? {} : { mediaProblem })}
            {...(onMediaProblemCleared === undefined ? {} : { onMediaProblemCleared })}
          />
        ) : (
          <ControlBar controls={{ screenShare: false, chat: false }} />
        )}
        <RoomAudioRenderer />
      </div>
    </StageContext.Provider>
  );
}
