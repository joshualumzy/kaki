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
      'Arjun, what happens in our POS if we change the drink names?',
      'Mei, how would our regulars react if we change the Kopi menu?',
      'Wei Ling, how does changing the drink names affect our kopi uncles in the kitchen?',
    ];
  }
  if (lower.includes('seat') || lower.includes('laptop') || lower.includes('chope')) {
    return [
      'Wei Ling, what happens on the floor when people chope tables?',
      'Arjun, why are laptop users staying in our booths all morning?',
      'Mei, what happens to our solo breakfast customers if we ban reserving seats?',
    ];
  }
  if (lower.includes('sfa') || lower.includes('salmonella') || lower.includes('inspection')) {
    return [
      'Daniel, what happens if Straits Times arrives at 8 AM and sees us still serving soft-boiled eggs?',
      'Mei, why did our egg holding bath dip to 58°C yesterday, and can we use the pasteurized backup cartons?',
      'Wei Ling, how much morning revenue do we lose if we pull soft-boiled eggs off the menu today?',
    ];
  }
  if (lower.includes('commission') || lower.includes('delivery') || lower.includes('platform')) {
    return [
      'Wei Ling, what does the 32% delivery commission do to our margin on a $10 breakfast set?',
      'Daniel, what happens to our CBD office accounts if we delist from GrabFood and Foodpanda today?',
      'Arjun, why can’t we just mark up our GrabFood prices by 30% or dispatch riders through our direct QR link?',
    ];
  }
  if (ownerRole === 'game_designer' || ownerRole === 'designer') {
    return [
      'Arjun, what happens in our POS if we change the drink names?',
      'Mei, how would our regulars react if we change the Kopi menu?',
      'Wei Ling, how does changing the drink names affect our kopi uncles in the kitchen?',
    ];
  }
  return [
    'Wei Ling, what happens on the floor when people chope tables?',
    'Arjun, why are laptop users staying in our booths all morning?',
    'Mei, what happens to our solo breakfast customers if we ban reserving seats?',
  ];
}

function reactionForColleague(
  attendeeName: string,
  chunks: readonly TranscriptChunk[],
  speaking: boolean,
  now: number,
): { emoji: string; label: string; tone: 'catch' | 'lock' | 'agree' } | undefined {
  const recentWindow = chunks.slice(-2);
  const latestByColleague = [...recentWindow].reverse().find((c) => c.payload.speaker === attendeeName);
  if (latestByColleague === undefined) return undefined;
  const latestAt = Date.parse(latestByColleague.payload.timestamp);
  const isFresh = speaking || (Number.isFinite(latestAt) && now - latestAt <= 4500);
  if (!isFresh) return undefined;

  const text = latestByColleague.payload.text;
  if (/\b(spot on|that works|lock(ed)? in|on it|got it|will do|works for me|sorted|solid plan|post that decision)\b/i.test(text)) {
    return { emoji: '🙌', label: 'Locked in', tone: 'lock' };
  }
  if (/\b(hold on|catch|careful|wait|problem|cannot|can't|forbid|refuse|wipe out|margin|docket|gloves|cancelled)\b/i.test(text)) {
    return { emoji: '🤔', label: 'Flagged a trade-off', tone: 'catch' };
  }
  if (/\b(agree|makes sense|good call|smart|love that|fair point|solid)\b/i.test(text)) {
    return { emoji: '👍', label: 'Sounds good', tone: 'agree' };
  }
  return undefined;
}

interface Stage {
  scenario: Scenario;
  chunks: TranscriptChunk[];
  now: number;
  npcState: NpcStateMessage;
  waitingForHuman: boolean;
}

const StageContext = createContext<Stage | null>(null);

function useStage(): Stage {
  const stage = useContext(StageContext);
  if (stage === null) throw new Error('useStage must be used inside MeetingGrid');
  return stage;
}

function CaptionedTile() {
  const { scenario, chunks, now, npcState } = useStage();
  const participant = useTrackRefContext().participant;
  const aiIndex = (scenario.npcs ?? []).findIndex((npc) => npc.attendee === participant.identity);
  const isAi = aiIndex >= 0;
  const humanSpeaking = useIsSpeaking(participant);
  const speaking = isAi ? npcState.kind === 'speaking' && npcState.speaker === participant.identity : humanSpeaking;
  const caption = captionFor(chunks, transcriptNameFor(scenario, participant), now, 8000, speaking);
  const thinking = isAi && npcState.kind === 'thinking';
  const state = speaking ? 'speaking' : thinking ? 'thinking' : 'idle';
  const attendee = isAi ? scenario.attendees.find((candidate) => candidate.name === participant.identity) : undefined;
  const roleTitle = isAi
    ? scenario.roles.find((role) => role.id === attendee?.role)?.label
    : participant.metadata?.trim() || undefined;
  const stance = isAi && attendee?.role !== undefined ? COLLEAGUE_STANCE[attendee.role] : undefined;
  const reaction = isAi
    ? reactionForColleague(participant.identity, chunks, speaking, now)
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
        <div className="kd-reaction-badge" data-tone={reaction.tone} aria-label={`${participant.identity}: ${reaction.label}`}>
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
export function MeetingGrid({ role }: { role: string }) {
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
  useEffect(() => {
    if (!waitingForHuman) setShowStarterIdeas(false);
  }, [waitingForHuman]);
  const stage = useMemo(
    () => ({ scenario, chunks, now, npcState, waitingForHuman }),
    [scenario, chunks, now, npcState, waitingForHuman],
  );

  const activeItem = scenario.agenda[activeAgendaIndex];
  const activeOwnerRole = activeItem?.ownerRole ?? role;

  const starterChips = useMemo(() => {
    const raw = starterChipsForItem(activeItem?.title, activeOwnerRole);
    const viewerSeatName = scenario.attendees.find((a) => a.role === role)?.name;
    if (viewerSeatName === undefined) return raw.slice(0, 2);
    return raw.filter((chip) => !chip.toLowerCase().startsWith(viewerSeatName.toLowerCase())).slice(0, 2);
  }, [activeItem?.title, activeOwnerRole, role, scenario.attendees]);

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
            ? `"${myTask.title}" is drafted. Review and click Approve & publish in the Kaki panel on the right →`
            : `"${myTask.title}": click "Let Kaki do it" in the Kaki panel on the right →`,
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
        text: `"${publishedTask.title}" is live. Open it in the Kaki panel on the right →`,
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
        text: `${latestFactOnCurrentTopic.payload.facts[0]?.text ?? latestFactOnCurrentTopic.payload.question} (see right panel →)`,
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
        {activeStageToast !== undefined && activeStageToast.key !== dismissedToastKey && (
          <div className="kd-stage-toast" role="status" aria-live="polite">
            <span className="kd-stage-toast-badge">{activeStageToast.badge}</span>
            <span className="kd-stage-toast-text">{activeStageToast.text}</span>
            <button
              type="button"
              className="kd-stage-toast-close"
              aria-label="Dismiss notification"
              onClick={() => setDismissedToastKey(activeStageToast.key)}
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
