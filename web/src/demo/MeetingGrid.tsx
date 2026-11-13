import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  ControlBar,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useDataChannel,
  useIsSpeaking,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTrackRefContext,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { CONTROL_TOPIC, NPC_STATE_TOPIC, type ControlMessage, type NpcStateMessage, type Scenario } from '@kaki/shared';
import { useKaki, useScenario } from '../kaki';
import { ConnectedTypeBar } from './TypeBar';
import { Orb, orbPalette } from './Orb';
import { captionFor, transcriptChunks, transcriptNameFor, type TranscriptChunk } from './captions';

const COLLEAGUE_STANCE: Record<string, string> = {
  producer: 'Guards staff, hygiene & margins',
  lead_programmer: 'Keeps POS & kiosks simple',
  engineer: 'Keeps POS & kiosks simple',
  game_designer: 'Protects Kopi & Toast craft',
  designer: 'Protects Kopi & Toast craft',
  marketing_lead: 'Watches TikTok & PR buzz',
  comms: 'Watches TikTok & PR buzz',
  studio_manager: 'Chairs the meeting',
  host: 'Chairs the meeting',
};

function starterChipsFromAgendaItem(
  item: Scenario['agenda'][number] | undefined,
  viewerSeatName: string | undefined,
  openQuestions: ReadonlyArray<{ text: string; forRole?: string }>,
): readonly string[] {
  const chips: string[] = [];
  for (const q of openQuestions) {
    if (q.text.trim().length > 0 && !chips.includes(q.text.trim())) {
      chips.push(q.text.trim());
    }
  }
  const tradeOffs = item?.discussion?.tradeOffs ?? [];
  for (const to of tradeOffs) {
    if (viewerSeatName !== undefined && to.attendee.toLowerCase() === viewerSeatName.toLowerCase()) continue;
    const question = to.question.trim();
    const addressed = question.toLowerCase().startsWith(to.attendee.toLowerCase())
      ? question
      : `${to.attendee}, ${question[0]!.toLowerCase()}${question.slice(1)}`;
    if (!chips.includes(addressed)) chips.push(addressed);
  }
  const fallback = [
    "Sam, could you summarize the two main options we're choosing between right now?",
    "That plan sounds solid to me — let's lock in both parts for tomorrow morning.",
  ];
  for (const fb of fallback) {
    if (!chips.includes(fb)) chips.push(fb);
  }
  return chips.slice(0, 2);
}

function reactionForColleague(
  attendeeName: string,
  chunks: readonly TranscriptChunk[],
  speaking: boolean,
  now: number,
  activeItemOwnerRole?: string,
  attendeeRole?: string,
  hasActiveTaskOnItem?: boolean,
): { emoji: string; label: string; tone: 'catch' | 'lock' | 'agree' } | undefined {
  // The person currently speaking never reacts to themselves with an emoji badge.
  if (speaking || chunks.length === 0) return undefined;
  const latest = chunks[chunks.length - 1]!;
  const latestSpeaker = latest.payload.speaker.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (latestSpeaker === attendeeName) return undefined;

  const latestAt = Date.parse(latest.payload.timestamp);
  if (!Number.isFinite(latestAt) || now - latestAt > 8500) return undefined;

  const text = latest.payload.text.trim();
  const isItemOwner = activeItemOwnerRole !== undefined && attendeeRole === activeItemOwnerRole;
  const mentionedByName = new RegExp(`\\b${attendeeName}\\b`, 'i').test(text);

  // 1. Semantic task/decision locked in -> warm celebration from listening leads
  if (
    hasActiveTaskOnItem ||
    /\b(lock(ed)? (?:that|this) in|solid plan|works for me|i'll post|i'll email|i'll file|i'll draft|appreciate it|let's go with that|let's do that|let's do both|do both)\b/i.test(
      text,
    )
  ) {
    if (isItemOwner || attendeeName === 'Sam' || mentionedByName) {
      return { emoji: '🙌', label: 'Locked in', tone: 'lock' };
    }
    return undefined;
  }

  // 2. Constructive agreement or endorsement -> supportive nod from listening colleagues
  if (
    /\b(good call|makes sense|that works|exactly right|spot on|fair point|good idea|sounds good|let's go with|i confirm|you(?:'re| are) right|helpful)\b/i.test(
      text,
    )
  ) {
    if (isItemOwner || attendeeName === 'Sam' || mentionedByName) {
      return { emoji: '👍', label: 'Supports this', tone: 'agree' };
    }
    return undefined;
  }

  // 3. Open question -> thoughtful consideration from the item owner or named colleague
  if (text.endsWith('?') && (isItemOwner || mentionedByName)) {
    return { emoji: '🤔', label: 'Thinking', tone: 'catch' };
  }

  return undefined;
}

interface Stage {
  scenario: Scenario;
  chunks: TranscriptChunk[];
  now: number;
  npcState: NpcStateMessage;
  waitingForHuman: boolean;
  activeItemOwnerRole?: string;
}

const StageContext = createContext<Stage | null>(null);

function useStage(): Stage {
  const stage = useContext(StageContext);
  if (stage === null) throw new Error('useStage must be used inside MeetingGrid');
  return stage;
}

function CaptionedTile() {
  const { scenario, chunks, now, npcState, activeItemOwnerRole } = useStage();
  const participant = useTrackRefContext().participant;
  const aiIndex = (scenario.npcs ?? []).findIndex((npc) => npc.attendee === participant.identity);
  const isAi = aiIndex >= 0;
  const humanSpeaking = useIsSpeaking(participant);
  const serverHumanSpeaking = !isAi && 'humanSpeaking' in npcState && npcState.humanSpeaking === true;
  const serverTranscribing = !isAi && 'transcribing' in npcState && npcState.transcribing === true;
  const speaking = isAi
    ? npcState.kind === 'speaking' && npcState.speaker === participant.identity
    : humanSpeaking || serverHumanSpeaking;
  const speakerAliases = isAi
    ? []
    : [participant.name ?? '', participant.identity, 'Guest'].filter((s) => s.trim().length > 0);
  const recognizedCaption = captionFor(
    chunks,
    transcriptNameFor(scenario, participant),
    now,
    isAi ? 8000 : 10000,
    speaking,
    speakerAliases,
  );
  const caption =
    !isAi && (humanSpeaking || serverHumanSpeaking)
      ? '🎙️ Speaking…'
      : !isAi && serverTranscribing
        ? '⏳ Transcribing…'
        : recognizedCaption;
  const thinking = isAi && npcState.kind === 'thinking';
  const state = speaking ? 'speaking' : thinking ? 'thinking' : 'idle';
  const attendee = isAi ? scenario.attendees.find((candidate) => candidate.name === participant.identity) : undefined;
  const roleTitle = isAi
    ? scenario.roles.find((role) => role.id === attendee?.role)?.label
    : participant.metadata?.trim() || undefined;
  const stance = isAi && attendee?.role !== undefined ? COLLEAGUE_STANCE[attendee.role] : undefined;
  const reaction = isAi
    ? reactionForColleague(participant.identity, chunks, speaking, now, activeItemOwnerRole, attendee?.role)
    : undefined;

  return (
    <div className="kd-tile" data-state={state} data-ai={isAi} style={{ ['--c' as string]: `var(${orbPalette(isAi ? aiIndex : 1)[0]})` }}>
      {isAi ? <Orb state={state} palette={orbPalette(aiIndex)} /> : <ParticipantTile style={{ width: '100%', height: '100%' }} />}
      <div className="kd-who">
        <i />
        <div className="kd-who-text">
          <div className="kd-who-line">
            <span>{isAi ? participant.identity : `${participant.name || participant.identity} (You)`}</span>
            {roleTitle !== undefined && <small className="kd-who-role">· {roleTitle}</small>}
          </div>
          {stance !== undefined && <small className="kd-who-stance">{stance}</small>}
        </div>
      </div>
      {reaction !== undefined && (
        <div
          className="kd-reaction-badge"
          data-tone={reaction.tone}
          style={{ ['--reaction-delay' as string]: `${(Math.max(0, aiIndex) % 3) * 240}ms` }}
          aria-label={`${participant.identity}: ${reaction.label}`}
        >
          <span className="kd-reaction-emoji">{reaction.emoji}</span>
        </div>
      )}
      {isAi && <div className="kd-state">{state}</div>}
      {caption !== null && (
        <div key={caption} className="kd-caption">
          {caption}
        </div>
      )}
    </div>
  );
}

/**
 * The role-card fact that best fits a topic: the one sharing the most topic words (four letters or more). Taking the
 * first loose match would show the same fact on every topic. Falls back to rotating by agenda position.
 */
export function pickCardFact(facts: readonly string[], topicText: string, agendaIndex: number): string | undefined {
  if (facts.length === 0) return undefined;
  const keywords = new Set((topicText.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(
    (w) => !['morning', 'tomorrow', 'without', 'before'].includes(w),
  ));
  let best: { fact: string; score: number } | undefined;
  for (const fact of facts) {
    const words = new Set(fact.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
    const score = [...keywords].filter((w) => words.has(w)).length;
    if (score > 0 && (best === undefined || score > best.score)) best = { fact, score };
  }
  return best?.fact ?? facts[agendaIndex % facts.length];
}

/** The meeting stage: one tile per participant with live captions, and the AI attendees' status. */
export function MeetingGrid({
  role,
  onOpenKaki,
  onKakiBadgeChange,
}: {
  role: string;
  onOpenKaki?: () => void;
  onKakiBadgeChange?: (count: number) => void;
}) {
  const scenario = useScenario();
  const room = useRoomContext();
  const { isMicrophoneEnabled } = useLocalParticipant();
  const { events } = useKaki(role);
  const { events: screenEvents, tasks: screenTasks } = useKaki('screen');
  const participants = useParticipants();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  // Captions fade by the clock, so the stage re-renders twice a second.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, []);

  const [npcState, setNpcState] = useState<NpcStateMessage>({ kind: 'idle' });
  useDataChannel(NPC_STATE_TOPIC, (message) => {
    try {
      setNpcState(JSON.parse(new TextDecoder().decode(message.payload)) as NpcStateMessage);
    } catch {
      // not a message from the AI attendees
    }
  });

  const aiNames = useMemo(() => new Set((scenario.npcs ?? []).map((npc) => npc.attendee)), [scenario]);
  const aiPresent = participants.some((participant) => aiNames.has(participant.identity));
  const chunks = useMemo(() => transcriptChunks(events), [events]);
  const facilitatorName = useMemo(() => {
    const hostRole = scenario.roles.find((r) => r.facilitator === true);
    return scenario.attendees.find((a) => a.role === hostRole?.id)?.name ?? 'Sam';
  }, [scenario]);
  const activeAgendaIndex = useMemo(() => {
    const latestRecord = [...screenEvents].reverse().find((e) => e.type === 'MEETING_RECORD_UPDATED');
    return latestRecord?.type === 'MEETING_RECORD_UPDATED' ? latestRecord.payload.agendaIndex : 0;
  }, [screenEvents]);

  // The agenda record only goes to the screen audience, so these must read the screen feed: it carries both that
  // record and every transcript line, in order.
  const hasColleagueBriefed = useMemo(() => {
    let currentIdx = 0;
    let sawCurrentItemBrief = false;
    for (const event of screenEvents) {
      if (event.type === 'MEETING_RECORD_UPDATED') {
        if (event.payload.agendaIndex !== currentIdx) {
          currentIdx = event.payload.agendaIndex;
          sawCurrentItemBrief = false;
        }
      } else if (
        event.type === 'TRANSCRIPT_CHUNK' &&
        currentIdx === activeAgendaIndex &&
        !event.payload.speaker.startsWith(facilitatorName)
      ) {
        sawCurrentItemBrief = true;
      }
    }
    return sawCurrentItemBrief;
  }, [screenEvents, facilitatorName, activeAgendaIndex]);
  const hasVisitorSpokenOnTopic = useMemo(() => {
    const npcNameSet = new Set((scenario.npcs ?? []).map((n) => n.attendee.toLowerCase()));
    let currentIdx = 0;
    let spoken = false;
    for (const event of screenEvents) {
      if (event.type === 'MEETING_RECORD_UPDATED') {
        if (event.payload.agendaIndex !== currentIdx) {
          currentIdx = event.payload.agendaIndex;
          spoken = false;
        }
      } else if (event.type === 'TRANSCRIPT_CHUNK' && currentIdx === activeAgendaIndex) {
        const cleanSpeaker = event.payload.speaker.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
        if (cleanSpeaker.length > 0 && !npcNameSet.has(cleanSpeaker)) {
          spoken = true;
        }
      }
    }
    return spoken;
  }, [screenEvents, scenario.npcs, activeAgendaIndex]);
  const waitingForHuman =
    npcState.kind === 'idle' && npcState.yourTurn !== undefined && hasColleagueBriefed;
  const idleAfterBriefing = npcState.kind === 'idle' && hasColleagueBriefed;
  const [showStarterIdeas, setShowStarterIdeas] = useState(false);
  const [turnWaitStartAt, setTurnWaitStartAt] = useState<number | null>(null);
  const [dismissedWingmanGlideKey, setDismissedWingmanGlideKey] = useState<string>('');
  const [latchedSemanticWingmanIdx, setLatchedSemanticWingmanIdx] = useState<number | null>(null);
  const [latchedWaitWingmanIdx, setLatchedWaitWingmanIdx] = useState<number | null>(null);

  useEffect(() => {
    setShowStarterIdeas(false);
    setLatchedSemanticWingmanIdx(null);
    setLatchedWaitWingmanIdx(null);
  }, [activeAgendaIndex]);

  useEffect(() => {
    if ('wingmanHint' in npcState && npcState.wingmanHint === true) {
      setLatchedSemanticWingmanIdx(activeAgendaIndex);
    }
  }, [npcState, activeAgendaIndex]);

  useEffect(() => {
    if (!idleAfterBriefing) {
      setTurnWaitStartAt(null);
    } else {
      setTurnWaitStartAt((prev) => prev ?? Date.now());
    }
  }, [idleAfterBriefing]);

  useEffect(() => {
    if (idleAfterBriefing && turnWaitStartAt !== null && now - turnWaitStartAt >= 10_000) {
      setLatchedWaitWingmanIdx(activeAgendaIndex);
    }
  }, [idleAfterBriefing, turnWaitStartAt, now, activeAgendaIndex]);
  const activeItem = scenario.agenda[activeAgendaIndex];
  const activeOwnerRole = activeItem?.ownerRole ?? role;
  const stage = useMemo(
    () => ({ scenario, chunks, now, npcState, waitingForHuman, activeItemOwnerRole: activeOwnerRole }),
    [scenario, chunks, now, npcState, waitingForHuman, activeOwnerRole],
  );

  const wingmanFactPreview = useMemo(() => {
    let latestFactText: string | undefined;
    for (const event of events) {
      if (
        event.type === 'FACT_FOUND' &&
        event.payload.facts.length > 0 &&
        event.payload.agendaIndex === activeAgendaIndex
      ) {
        const text = event.payload.facts[0]?.text;
        if (text !== undefined) latestFactText = text;
      }
    }
    if (latestFactText !== undefined) return latestFactText;
    const myRoleFacts = scenario.roles.find((r) => r.id === role)?.card?.facts ?? [];
    if (myRoleFacts.length === 0 || activeItem === undefined) return undefined;
    const tradeOffText = (activeItem.discussion?.tradeOffs ?? [])
      .map((t) => `${t.tradeOff} ${t.question}`)
      .join(' ');
    const topicText = `${activeItem.title} ${activeItem.decision ?? ''} ${tradeOffText}`.toLowerCase();
    return pickCardFact(myRoleFacts, topicText, activeAgendaIndex);
  }, [events, scenario.roles, role, activeItem, activeAgendaIndex]);

  const starterChips = useMemo(() => {
    const viewerSeatName = scenario.attendees.find((a) => a.role === role)?.name;
    const latestRecord = [...screenEvents].reverse().find((e) => e.type === 'MEETING_RECORD_UPDATED');
    const openQs = latestRecord?.type === 'MEETING_RECORD_UPDATED' ? latestRecord.payload.openQuestions : [];
    return starterChipsFromAgendaItem(activeItem, viewerSeatName, openQs);
  }, [activeItem, role, scenario.attendees, screenEvents]);

  const sendQuickLine = useCallback(
    (text: string) => {
      window.dispatchEvent(new Event('kaki:quick-line'));
      const msg: ControlMessage = { kind: 'text', text };
      room.localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(msg)), { reliable: true, topic: CONTROL_TOPIC })
        .catch(() => undefined);
    },
    [room],
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

  const wingmanGlideNudge = useMemo(() => {
    if (wingmanFactPreview === undefined) return undefined;
    const semanticWingmanHint =
      ('wingmanHint' in npcState && npcState.wingmanHint === true) ||
      latchedSemanticWingmanIdx === activeAgendaIndex;
    let hasSemanticFactOrNudgeOnTopic = false;
    for (const event of events) {
      if (
        (event.type === 'FACT_FOUND' || event.type === 'NUDGE') &&
        event.payload.agendaIndex === activeAgendaIndex &&
        hasColleagueBriefed
      ) {
        hasSemanticFactOrNudgeOnTopic = true;
      }
    }
    const waitedLongEnough =
      (idleAfterBriefing && turnWaitStartAt !== null && now - turnWaitStartAt >= 10_000) ||
      latchedWaitWingmanIdx === activeAgendaIndex;
    if (!semanticWingmanHint && !hasSemanticFactOrNudgeOnTopic && !waitedLongEnough) return undefined;
    const key = semanticWingmanHint
      ? `glide-semantic:${activeAgendaIndex}`
      : hasSemanticFactOrNudgeOnTopic
        ? `glide-fact:${activeAgendaIndex}`
        : `glide-wait:${activeAgendaIndex}`;
    const proposalChip = /^Consider proposing:\s*/i.test(wingmanFactPreview)
      ? wingmanFactPreview.replace(/^Consider proposing:\s*/i, '').trim()
      : undefined;
    return {
      key,
      reason: semanticWingmanHint || hasSemanticFactOrNudgeOnTopic
        ? '✨ Kaki Wingman · Store fact for this question'
        : '✨ Kaki Wingman · Quick tip for your turn',
      fact: wingmanFactPreview,
      chip: proposalChip ?? starterChips[0],
      isDirectProposal: proposalChip !== undefined,
    };
  }, [wingmanFactPreview, npcState, latchedSemanticWingmanIdx, latchedWaitWingmanIdx, events, activeAgendaIndex, hasColleagueBriefed, idleAfterBriefing, turnWaitStartAt, now, starterChips]);

  const activeStageToast = useMemo(() => {
    const allTasks = [...screenTasks.values()];
    const myTask = allTasks
      .filter((t) => (t.assignee ?? t.suggestedAssignee) === role)
      .find((t) => t.status === 'DISPATCHED' || t.status === 'DRAFT_READY');
    if (myTask !== undefined) {
      const key = `task:${myTask.id}:${myTask.status}`;
      return {
        key,
        badge: myTask.status === 'DRAFT_READY' ? 'Kaki Action · Draft Ready' : 'Kaki Action · Assigned to You',
        text:
          myTask.status === 'DRAFT_READY'
            ? `"${myTask.title}" is drafted. Review and click Approve & publish in Kaki →`
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
    let latestFactOnCurrentTopic: Extract<typeof events[number], { type: 'FACT_FOUND' }> | undefined;
    for (const event of events) {
      if (
        event.type === 'FACT_FOUND' &&
        event.payload.facts.length > 0 &&
        event.payload.agendaIndex === activeAgendaIndex
      ) {
        latestFactOnCurrentTopic = event;
      }
    }
    if (latestFactOnCurrentTopic !== undefined && hasColleagueBriefed) {
      const key = `fact:${activeAgendaIndex}:${latestFactOnCurrentTopic.payload.question}`;
      return {
        key,
        badge: 'Kaki Wingman · Record Found',
        text: `${latestFactOnCurrentTopic.payload.facts[0]?.text ?? latestFactOnCurrentTopic.payload.question} (open Kaki →)`,
      };
    }
    return undefined;
  }, [screenTasks, events, role, hasColleagueBriefed, activeAgendaIndex]);

  return (
    <StageContext.Provider value={stage}>
      <div className="kd-stage-col">
        {npcState.kind === 'error' && (
          <div role="alert" className="kd-banner" data-tone="error">
            The AI attendees hit a problem: {npcState.message}
          </div>
        )}
        {!aiPresent && (
          <div className="kd-banner">
            Waiting for the AI attendees. Start them with <code>npm run npc</code>.
          </div>
        )}
        {wingmanGlideNudge !== undefined && wingmanGlideNudge.key !== dismissedWingmanGlideKey && (
          <div
            className="kd-wingman-glide"
            role="status"
            aria-live="polite"
          >
            <div
              className="kd-wingman-glide-main"
              onClick={() => {
                onOpenKaki?.();
                document.querySelector('.kd-topic-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              }}
              style={{ cursor: 'pointer' }}
            >
              <span className="kd-wingman-glide-badge">{wingmanGlideNudge.reason}</span>
              <p className="kd-wingman-glide-fact">{wingmanGlideNudge.fact}</p>
            </div>
            <div className="kd-wingman-glide-actions">
              {wingmanGlideNudge.isDirectProposal && wingmanGlideNudge.chip !== undefined ? (
                <button
                  type="button"
                  className="kd-wingman-glide-btn kd-wingman-glide-btn-say"
                  onClick={() => {
                    sendQuickLine(wingmanGlideNudge.chip!);
                    setDismissedWingmanGlideKey(wingmanGlideNudge.key);
                  }}
                >
                  💬 Say this proposal
                </button>
              ) : (
                <button
                  type="button"
                  className="kd-wingman-glide-btn kd-wingman-glide-btn-say"
                  onClick={() => {
                    setShowStarterIdeas(true);
                    setDismissedWingmanGlideKey(wingmanGlideNudge.key);
                  }}
                >
                  💡 See what to say
                </button>
              )}
              <button
                type="button"
                className="kd-wingman-glide-btn"
                onClick={() => {
                  onOpenKaki?.();
                  document.querySelector('.kd-topic-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  setDismissedWingmanGlideKey(wingmanGlideNudge.key);
                }}
              >
                Open Kaki panel →
              </button>
              <button
                type="button"
                className="kd-stage-toast-close"
                aria-label="Dismiss Wingman tip"
                onClick={() => setDismissedWingmanGlideKey(wingmanGlideNudge.key)}
              >
                ✕
              </button>
            </div>
          </div>
        )}
        {activeStageToast !== undefined &&
          activeStageToast.key !== dismissedToastKey &&
          (wingmanGlideNudge === undefined || wingmanGlideNudge.key === dismissedWingmanGlideKey || activeStageToast.key.startsWith('task:')) && (
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
          <GridLayout tracks={tracks} style={{ height: '100%' }}>
            <CaptionedTile />
          </GridLayout>
        </div>
        {(idleAfterBriefing || showStarterIdeas) && (
          <div className="kd-turn-bar" role="region" aria-label="Your turn and starter questions">
            <div className="kd-turn-row">
              <span className="kd-turn-pill">
                {showStarterIdeas
                  ? '🟢 Click any line below to say it immediately (or speak/type)'
                  : waitingForHuman
                    ? '🟢 Your turn — speak on mic or type below'
                    : '💬 Jump in anytime — speak, type, or click Need an idea?'}
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
              <div className="kd-starter-chips">
                {starterChips.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className="kd-starter-chip"
                    onClick={() => {
                      sendQuickLine(chip);
                      setShowStarterIdeas(false);
                    }}
                  >
                    💬 {chip}
                  </button>
                ))}
                {hasVisitorSpokenOnTopic && (
                  <button
                    type="button"
                    className="kd-starter-chip"
                    onClick={() => {
                      sendQuickLine(
                        "We're split on this — let's table it for now and set up a follow-up to settle it later.",
                      );
                      setShowStarterIdeas(false);
                    }}
                  >
                    ⏭️ Table topic &amp; set a follow-up
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <ConnectedTypeBar micOnline={isMicrophoneEnabled} />
        <ControlBar controls={{ screenShare: false, chat: false }} />
        <RoomAudioRenderer />
      </div>
    </StageContext.Provider>
  );
}
