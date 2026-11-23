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
import { CaptionedTile, PendingTile, StageContext } from './CaptionedTile';
import { RealMeetingBar } from './RealMeetingBar';
import { RealRoomBanners, RealWaitingOverlay } from './RealRoomOverlays';
import { MutedHint } from './MutedHint';
import { useRealRoom } from './realRoom';
import { distinctDisplayNames, peopleNotInRoom } from './people';
import { activeStageTaskFor, starterChipsFromAgendaItem, tracksWithSpeakerFirst, visibleStageTracks } from './stageModel';
import { textOnlyNote, transcriptChunks } from './captions';
import { WingmanActNow } from './WingmanPanel';

/** The meeting stage: one tile per participant with live captions, and the AI attendees' status. */
export function MeetingGrid({
  role,
  onOpenKaki,
  onKakiBadgeChange,
  sharedAudience = 'screen',
  real = false,
  meetingId,
  meetingCode,
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
}) {
  const scenario = useScenario();
  const realRoom = useRealRoom();
  const meetingState = realRoom?.meetingState;
  const offTheRecord = real && meetingState?.offTheRecord !== null && meetingState?.offTheRecord !== undefined;
  const { localParticipant } = useLocalParticipant();
  const { events, send: sendToServer, wingmanNotes } = useKaki({ kind: 'role', role });
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
        key: `outage:${speechStatus.outage.message}`,
        text:
          ownSpeechFailure === undefined
            ? speechStatus.outage.message
            : `${speechStatus.outage.message} Your last line was not heard.`,
      };
    }
    if (ownSpeechFailure !== undefined) {
      return {
        key: `failed:${ownSpeechFailure.message ?? 'failed'}`,
        text: ownSpeechFailure.message ?? 'Kaki could not hear that. Please say it again.',
      };
    }
    return undefined;
  }, [speechStatus.outage, ownSpeechFailure]);
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
  const hasVisitorSpokenOnTopic = useMemo(() => {
    const speech = speechByTopic.get(activeAgendaIndex);
    if (speech === undefined) return false;
    if (speech.roles.has(role)) return true;
    const npcNameSet = new Set((scenario.npcs ?? []).map((n) => n.attendee.toLowerCase()));
    for (const speaker of speech.names) {
      if (!npcNameSet.has(speaker)) return true;
    }
    return false;
  }, [speechByTopic, scenario.npcs, activeAgendaIndex, role]);
  const waitingForHuman =
    npcState.kind === 'idle' && npcState.yourTurn !== undefined && hasColleagueBriefed;
  const idleAfterBriefing = npcState.kind === 'idle' && hasColleagueBriefed;
  const [showStarterIdeas, setShowStarterIdeas] = useState(false);

  useEffect(() => {
    setShowStarterIdeas(false);
  }, [activeAgendaIndex]);

  const activeItem = scenario.agenda[activeAgendaIndex];
  const activeOwnerRole = activeItem?.ownerRole ?? role;
  const stage = useMemo(
    () => ({
      scenario, chunks, events, now, npcState, speechStatus, waitingForHuman,
      activeItemOwnerRole: activeOwnerRole, activeAgendaIndex, avatars, offTheRecord,
    }),
    [scenario, chunks, events, now, npcState, speechStatus, waitingForHuman, activeOwnerRole, activeAgendaIndex, avatars, offTheRecord],
  );

  const starterChips = useMemo(() => {
    const viewerSeatName = scenario.attendees.find((a) => a.role === role)?.name;
    const openQs = latestRecord?.payload.openQuestions.filter(
      (question) => question.agendaIndex === activeAgendaIndex,
    ) ?? [];
    const hostName = facilitatorRole === undefined ? undefined : facilitatorName;
    return starterChipsFromAgendaItem(activeItem, viewerSeatName, openQs, hostName);
  }, [activeItem, role, scenario.attendees, latestRecord, activeAgendaIndex, facilitatorName, facilitatorRole]);

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

  const activeStageToast = useMemo(() => {
    const allTasks = [...screenTasks.values()];
    const myTask = activeStageTaskFor(allTasks, role, activeItem?.title);
    if (myTask !== undefined) {
      const key = `task:${myTask.id}:${myTask.status}`;
      return {
        key,
        badge: myTask.status === 'DRAFT_READY' ? 'Kaki Action · Draft Ready' : 'Kaki Action · Assigned to You',
        text:
          myTask.status === 'DRAFT_READY'
            ? narrow
              ? `"${myTask.title}" is drafted — review in Kaki →`
              : `"${myTask.title}" is drafted. Review and click Approve & publish in Kaki →`
            : narrow
              ? `"${myTask.title}" needs you in Kaki →`
              : `"${myTask.title}": click "Let Kaki do it" in Kaki →`,
      };
    }
    const publishedTask = [...allTasks]
      .reverse()
      .find((t) => (t.status === 'COMPLETED' || t.status === 'SYNCED') && t.artifactUrl !== undefined);
    if (publishedTask !== undefined) {
      const key = `published:${publishedTask.id}:${publishedTask.status}`;
      return {
        key,
        badge: 'Kaki Action · Published',
        text: `"${publishedTask.title}" is live. Open it in Kaki →`,
      };
    }
    return undefined;
  }, [screenTasks, role, activeItem, narrow]);

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
    (!topicSettled || activeStageToast.key.startsWith('task:') || activeStageToast.key.startsWith('published:')) &&
    !(!narrow && activeStageToast.key.startsWith('task:') && actionableMyTasksCount > 0);

  return (
    <StageContext.Provider value={stage}>
      <div className="kd-stage-col">
        {real ? <RealRoomBanners /> : null}
        {!real && npcState.kind === 'error' && (
          <div role="alert" className="kd-banner" data-tone="error">
            The AI attendees hit a problem: {npcState.message}
          </div>
        )}
        {!real && speechRecording === false && (
          <div role="alert" className="kd-banner" data-tone="error">
            Speech is not being recorded: the AI service is not connected. Start it with{' '}
            <code>npm run npc</code>.
          </div>
        )}
        {!offTheRecord && speechNotice !== undefined && (
          <div role="alert" className="kd-banner" data-tone="error">
            {speechNotice.text}
            {/* A real meeting keeps its Type button in the bottom bar; practice is speech only. */}
            {real ? ' You can also use Type below.' : null}
          </div>
        )}
        {!real && (scenario.npcs ?? []).length > 0 && !aiPresent && (
          <div className="kd-banner">
            Waiting for the AI attendees. Start them with <code>npm run npc</code>.
          </div>
        )}
        {!offTheRecord && (
          <WingmanActNow
            notes={wingmanNotes}
            onDismiss={(id) => sendToServer({ type: 'DISMISS_WINGMAN_NOTE', id })}
          />
        )}
        {!offTheRecord && stageToastVisible && activeStageToast !== undefined && (
          <div
            className="kd-stage-toast"
            role="status"
            aria-live="polite"
            onClick={() => {
              onOpenKaki?.();
              const targetSelector = activeStageToast.key.startsWith('task:')
                ? '.kd-role-active'
                : activeStageToast.key.startsWith('published:')
                  ? '.kd-role-active, .kd-tasks'
                  : '.kd-topic-card';
              document.querySelector(targetSelector)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }}
            style={{ cursor: 'pointer' }}
          >
            <span className="kd-stage-toast-badge">{activeStageToast.badge}</span>
            <span className="kd-stage-toast-text">{activeStageToast.text}</span>
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
        {!real && (idleAfterBriefing || showStarterIdeas) && !meetingWrappedUp && !topicSettled && (
          <div className="kd-turn-bar" role="region" aria-label="Your turn and starter questions">
            <div className="kd-turn-row">
              <span className="kd-turn-pill">
                {showStarterIdeas
                  ? '🟢 Say one of these, or put it in your own words'
                  : waitingForHuman
                    ? '🟢 Your turn — just speak'
                    : '💬 Jump in anytime — just speak, or tap Need an idea?'}
              </span>
              <button
                type="button"
                className="kd-turn-idea-btn"
                aria-expanded={showStarterIdeas}
                onClick={() => setShowStarterIdeas((prev) => !prev)}
              >
                {showStarterIdeas ? 'Hide ideas' : '💡 Need an idea?'}
              </button>
            </div>
            {showStarterIdeas && (
              // Ideas to say out loud: speaking is the only way in, so nothing here sends a line.
              <ul className="kd-starter-chips">
                {starterChips.map((chip) => (
                  <li key={chip} className="kd-starter-chip">
                    💬 {chip}
                  </li>
                ))}
                {hasVisitorSpokenOnTopic && (
                  <li className="kd-starter-chip">
                    ⏭️ We&apos;re split on this — let&apos;s table it for now and set up a follow-up to settle it later.
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
        <MutedHint />
        {real ? (
          <RealMeetingBar
            meetingId={meetingId ?? ''}
            {...(meetingCode === undefined ? {} : { meetingCode })}
          />
        ) : (
          <ControlBar controls={{ screenShare: false, chat: false }} />
        )}
        <RoomAudioRenderer />
      </div>
    </StageContext.Provider>
  );
}
