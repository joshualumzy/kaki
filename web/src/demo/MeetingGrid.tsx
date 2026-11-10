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

function starterChipsForItem(itemTitle: string | undefined, ownerRole: string): readonly string[] {
  const lower = (itemTitle ?? '').toLowerCase();
  if (lower.includes('kiosk') || lower.includes('kopi')) {
    return [
      'Arjun, can the kiosk show plain-English drink names while still printing short Kopi names on the kitchen ticket?',
      'Mei, what if we keep Kopi names on the buttons and add a simple 2-step Milk & Sugar popup for first-timers?',
      'Wei Ling, if kitchen tickets keep the short Kopi names, can we test the new kiosk screen tonight before 8 AM?',
    ];
  }
  if (lower.includes('seat') || lower.includes('laptop') || lower.includes('chope')) {
    return [
      'Arjun, can we use the smart switch in the back room to turn off booth plugs and Wi-Fi from 8 to 10 AM?',
      'Mei, what if we save the 2-seater tables for solo diners using numbered table tokens from the kiosk?',
      'Wei Ling, if we turn off booth plugs automatically and put up table signs, does that protect Auntie Mary?',
    ];
  }
  if (lower.includes('sfa') || lower.includes('salmonella') || lower.includes('inspection')) {
    return [
      'Mei, can we clean the egg warmer tonight and use our two sealed backup cartons of pasteurized eggs at 63°C tomorrow?',
      'Wei Ling, can we log digital temperature checks at 63°C every 15 minutes tomorrow to show the 9 AM SFA inspector?',
      'Daniel, if we use our pasteurized backup eggs at 63°C and show live temperature logs, what should we tell the 8 AM reporters?',
    ];
  }
  if (lower.includes('commission') || lower.includes('delivery') || lower.includes('platform')) {
    return [
      'Arjun, since raising single-set prices gets our store hidden on GrabFood, can we add a 5-set Office Platter instead?',
      'Wei Ling, how much profit do we make on a $55 5-set Office Platter on GrabFood compared to single $10 sets?',
      'Daniel, can we give nearby office regulars a free drink upgrade if they order self-pickup on our website QR code?',
    ];
  }
  if (ownerRole === 'game_designer' || ownerRole === 'designer') {
    return [
      'Arjun, can the kiosk show plain-English drink names while still printing short Kopi names on the kitchen ticket?',
      'Mei, what if we keep Kopi names on the buttons and add a simple 2-step Milk & Sugar popup for first-timers?',
      'Wei Ling, if kitchen tickets keep the short Kopi names, can we test the new kiosk screen tonight before 8 AM?',
    ];
  }
  return [
    'Arjun, can we use the smart switch in the back room to turn off booth plugs and Wi-Fi from 8 to 10 AM?',
    'Mei, what if we save the 2-seater tables for solo diners using numbered table tokens from the kiosk?',
    'Wei Ling, if we turn off booth plugs automatically and put up table signs, does that protect Auntie Mary?',
  ];
}

function reactionForColleague(
  attendeeName: string,
  chunks: readonly TranscriptChunk[],
  speaking: boolean,
  now: number,
  activeItemOwnerRole?: string,
  attendeeRole?: string,
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

  // 1. Decision locked in / task accepted -> warm celebration from listening leads (item owner, Sam, or named colleague)
  if (
    /\b(lock(ed)? (?:that|this) in|solid plan|works for me|i'll post|i'll email|i'll file|i'll draft|i'll configure|i'll schedule|appreciate it|thanks boss|let's go with that|let's do that|let's do both|do both)\b/i.test(
      text,
    )
  ) {
    if (isItemOwner || attendeeName === 'Sam' || mentionedByName) {
      return { emoji: '🙌', label: 'Locked in', tone: 'lock' };
    }
    return undefined;
  }

  // 2. Constructive agreement, endorsement, or practical compromise -> supportive nod from listening colleagues
  if (
    /\b(that's a good call|good call|makes sense|that works|works for me|exactly right|spot on|fair point|good idea|sounds good|let's go with|we can use|we can configure|smart switch|pasteurized|office platter|table token|milk\s*(?:&|and)\s*sugar|i confirm|you(?:'re| are) right|very helpful)\b/i.test(
      text,
    )
  ) {
    if (isItemOwner || attendeeName === 'Sam' || mentionedByName) {
      return { emoji: '👍', label: 'Supports this', tone: 'agree' };
    }
    return undefined;
  }

  // 3. Alarming ground crisis or hard operational blocker -> brief concern/shock from the item lead or GM
  if (
    /\b(hospitalized|yelled at|screamed at|backed into the walkway|32%|hides our shop|wipes out \$1,800|scalding hot tray|froze|stalled|58 degrees|58°C|slowed down|lose \$|losing \$)\b/i.test(
      text,
    )
  ) {
    if (isItemOwner || attendeeName === 'Sam' || mentionedByName) {
      return { emoji: '😟', label: 'Concerned', tone: 'catch' };
    }
  }

  // 4. Open trade-off question or weighing options -> thoughtful consideration from the item owner or named colleague
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

  const hasColleagueBriefed = useMemo(() => {
    let currentIdx = 0;
    let sawCurrentItemBrief = false;
    for (const event of events) {
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
  }, [events, facilitatorName, activeAgendaIndex]);
  const waitingForHuman =
    npcState.kind === 'idle' && npcState.yourTurn !== undefined && hasColleagueBriefed;
  const [showStarterIdeas, setShowStarterIdeas] = useState(false);
  const [turnWaitStartAt, setTurnWaitStartAt] = useState<number | null>(null);
  const [dismissedWingmanGlideKey, setDismissedWingmanGlideKey] = useState<string>('');
  useEffect(() => {
    if (!waitingForHuman) {
      setShowStarterIdeas(false);
      setTurnWaitStartAt(null);
    } else {
      setTurnWaitStartAt((prev) => prev ?? Date.now());
    }
  }, [waitingForHuman]);
  const activeItem = scenario.agenda[activeAgendaIndex];
  const activeOwnerRole = activeItem?.ownerRole ?? role;
  const stage = useMemo(
    () => ({ scenario, chunks, now, npcState, waitingForHuman, activeItemOwnerRole: activeOwnerRole }),
    [scenario, chunks, now, npcState, waitingForHuman, activeOwnerRole],
  );

  const currentItemTranscriptLower = useMemo(() => {
    let idx = 0;
    const texts: string[] = [];
    for (const event of events) {
      if (event.type === 'MEETING_RECORD_UPDATED') {
        idx = event.payload.agendaIndex;
      } else if (event.type === 'TRANSCRIPT_CHUNK' && idx === activeAgendaIndex) {
        texts.push(event.payload.text.toLowerCase());
      }
    }
    return texts.join(' ');
  }, [events, activeAgendaIndex]);

  const wingmanFactPreview = useMemo(() => {
    let factIdx = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.type === 'FACT_FOUND' && event.payload.facts.length > 0) {
        const text = event.payload.facts[0]?.text;
        if (text !== undefined) return text;
      }
    }
    const myRoleFacts = scenario.roles.find((r) => r.id === role)?.card?.facts ?? [];
    if (myRoleFacts.length === 0 || activeItem === undefined) return undefined;
    const topicText = `${activeItem.title} ${activeItem.decision ?? ''}`.toLowerCase();
    const keywords = (topicText.match(/[a-z0-9]{4,}/g) ?? []).filter(
      (w) => !['morning', 'tomorrow', 'without', 'before'].includes(w),
    );
    const matched = myRoleFacts.find((fact) => keywords.some((w) => fact.toLowerCase().includes(w)));
    void factIdx;
    return matched ?? myRoleFacts[0];
  }, [events, scenario.roles, role, activeItem]);

  const starterChips = useMemo(() => {
    const raw = starterChipsForItem(activeItem?.title, activeOwnerRole);
    const viewerSeatName = scenario.attendees.find((a) => a.role === role)?.name;
    const roleFiltered =
      viewerSeatName === undefined
        ? [...raw]
        : raw.filter((chip) => !chip.toLowerCase().startsWith(viewerSeatName.toLowerCase()));
    const chipAlreadyCovered = (chip: string): boolean => {
      const lower = chip.toLowerCase();
      if (lower.includes('5-set') && /5-set|five-set|platter|bundle/.test(currentItemTranscriptLower)) return true;
      if (lower.includes('free drink') && /free drink|drink upgrade/.test(currentItemTranscriptLower)) return true;
      if (lower.includes('smart switch') && /smart switch/.test(currentItemTranscriptLower)) return true;
      if (lower.includes('table token') && /table token|numbered token/.test(currentItemTranscriptLower)) return true;
      if (lower.includes('pasteurized') && /pasteurized/.test(currentItemTranscriptLower)) return true;
      if (lower.includes('plain-english') && /pos v2\.4|short kopi/.test(currentItemTranscriptLower)) return true;
      if (lower.includes('milk & sugar') && /milk\s*(?:&|and)\s*sugar|two-step|2-step/.test(currentItemTranscriptLower))
        return true;
      return false;
    };
    const fresh = roleFiltered.filter((chip) => !chipAlreadyCovered(chip));
    const fallbackChips = [
      "Sam, could you summarize the main options we're choosing between right now?",
      "That plan sounds solid to me — let's lock in both parts for tomorrow morning.",
    ];
    return [...fresh, ...fallbackChips].slice(0, 2);
  }, [activeItem?.title, activeOwnerRole, role, scenario.attendees, currentItemTranscriptLower]);

  const sendQuickLine = useCallback(
    (text: string) => {
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
    let idx = 0;
    let latestVisitorLine = '';
    for (const event of events) {
      if (event.type === 'MEETING_RECORD_UPDATED') {
        idx = event.payload.agendaIndex;
        latestVisitorLine = '';
      } else if (event.type === 'TRANSCRIPT_CHUNK' && idx === activeAgendaIndex) {
        const spk = event.payload.speaker.replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (!aiNames.has(spk)) {
          latestVisitorLine = event.payload.text.trim();
        }
      }
    }
    const visitorAskedForHelp =
      latestVisitorLine.length > 0 &&
      /\b(?:i don'?t know|idk|not sure|no idea|how am i supposed to know|what(?:'s| is) the (?:actual )?cost|how much (?:does|is|do)|what is in|what's in|what are the|remind me|forgot|help me|what should (?:i|we) do|give me a solution|what options)\b/i.test(
        latestVisitorLine,
      );
    const waitedLongEnough =
      waitingForHuman && turnWaitStartAt !== null && now - turnWaitStartAt >= 10_000;
    if (!visitorAskedForHelp && !waitedLongEnough) return undefined;
    const key = visitorAskedForHelp
      ? `glide-ask:${activeAgendaIndex}:${latestVisitorLine}`
      : `glide-wait:${activeAgendaIndex}`;
    return {
      key,
      reason: visitorAskedForHelp
        ? '✨ Kaki Wingman · Here is the info you need'
        : '✨ Kaki Wingman · Quick tip for your turn',
      fact: wingmanFactPreview,
      chip: starterChips[0],
    };
  }, [wingmanFactPreview, events, activeAgendaIndex, aiNames, waitingForHuman, turnWaitStartAt, now, starterChips]);

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
    let factIdx = 0;
    let latestFactOnCurrentTopic: Extract<typeof events[number], { type: 'FACT_FOUND' }> | undefined;
    for (const event of events) {
      if (event.type === 'MEETING_RECORD_UPDATED') {
        factIdx = event.payload.agendaIndex;
      } else if (
        event.type === 'FACT_FOUND' &&
        event.payload.facts.length > 0 &&
        factIdx === activeAgendaIndex
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
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
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
            <div className="kd-wingman-glide-main" onClick={() => onOpenKaki?.()} style={{ cursor: onOpenKaki ? 'pointer' : undefined }}>
              <span className="kd-wingman-glide-badge">{wingmanGlideNudge.reason}</span>
              <p className="kd-wingman-glide-fact">{wingmanGlideNudge.fact}</p>
            </div>
            <div className="kd-wingman-glide-actions">
              {wingmanGlideNudge.chip !== undefined && (
                <button
                  type="button"
                  className="kd-wingman-glide-btn kd-wingman-glide-btn-say"
                  onClick={() => {
                    sendQuickLine(wingmanGlideNudge.chip!);
                    setDismissedWingmanGlideKey(wingmanGlideNudge.key);
                  }}
                >
                  💬 Say this
                </button>
              )}
              <button
                type="button"
                className="kd-wingman-glide-btn"
                onClick={() => {
                  onOpenKaki?.();
                  setDismissedWingmanGlideKey(wingmanGlideNudge.key);
                }}
              >
                Check right panel →
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
        {activeStageToast !== undefined && activeStageToast.key !== dismissedToastKey && (
          <div
            className="kd-stage-toast"
            role="status"
            aria-live="polite"
            onClick={() => onOpenKaki?.()}
            style={{ cursor: onOpenKaki ? 'pointer' : undefined }}
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
        <div style={{ flex: 1, padding: '10px', minHeight: 0 }}>
          <GridLayout tracks={tracks} style={{ height: '100%' }}>
            <CaptionedTile />
          </GridLayout>
        </div>
        {waitingForHuman && (
          <div className="kd-turn-bar" role="region" aria-label="Your turn and starter questions">
            <div className="kd-turn-row">
              <span className="kd-turn-pill">
                🟢 Floor is yours: {npcState.kind === 'idle' && npcState.yourTurn ? npcState.yourTurn : 'speak on mic or type below'}
              </span>
              <button
                type="button"
                className="kd-turn-idea-btn"
                aria-expanded={showStarterIdeas}
                onClick={() => setShowStarterIdeas((prev) => !prev)}
              >
                {showStarterIdeas ? 'Hide ideas' : '💡 Need a question idea?'}
              </button>
            </div>
            {showStarterIdeas && (
              <div className="kd-starter-chips">
                {wingmanFactPreview !== undefined && (
                  <div
                    style={{
                      flex: '1 1 100%',
                      padding: '6px 10px',
                      borderRadius: 10,
                      background: 'var(--color-accent-soft)',
                      border: '1px solid var(--color-accent)',
                      fontSize: 12,
                      lineHeight: 1.35,
                      color: 'var(--color-text)',
                    }}
                  >
                    <strong>📌 Kaki Wingman fact for your role:</strong> {wingmanFactPreview}
                  </div>
                )}
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
