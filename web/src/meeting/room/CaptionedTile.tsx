import { createContext, useContext } from 'react';
import {
  ParticipantTile,
  useIsSpeaking,
  useLocalParticipant,
  useTrackRefContext,
} from '@livekit/components-react';
import {
  type KakiEvent,
  type NpcStateMessage,
  type Scenario,
  type SpeechStatusMessage,
} from '@kaki/shared';
import { Avatar } from '../../ui';
import { Orb, orbPalette } from './Orb';
import { captionFor, transcriptNameFor, type TranscriptChunk } from './captions';
import { colleagueStance, reactionForColleague } from './stageModel';

/** The live meeting values a captioned tile reads from the stage. */
export interface Stage {
  scenario: Scenario;
  chunks: TranscriptChunk[];
  events: KakiEvent[];
  now: number;
  npcState: NpcStateMessage;
  speechStatus: SpeechStatusMessage;
  waitingForHuman: boolean;
  activeItemOwnerRole?: string;
  activeAgendaIndex: number;
  /** Real-meeting people by identity and by seat, so a tile can show the right photo. */
  avatars?: Map<string, { displayName: string; photoUrl: string | null }>;
  /** While the room is off the record, no caption or reaction may appear on any tile. */
  offTheRecord?: boolean;
}

/** Carries the stage values to the tiles without passing them through every component. */
export const StageContext = createContext<Stage | null>(null);

function useStage(): Stage {
  const stage = useContext(StageContext);
  if (stage === null) throw new Error('useStage must be used inside MeetingGrid');
  return stage;
}

/** One participant tile with its live caption, speaking state and reaction badge. */
export function CaptionedTile() {
  const { scenario, chunks, events, now, npcState, speechStatus, avatars, offTheRecord } = useStage();
  const participant = useTrackRefContext().participant;
  const localParticipant = useLocalParticipant().localParticipant;
  const isYou = localParticipant !== undefined && participant.identity === localParticipant.identity;
  const aiIndex = (scenario.npcs ?? []).findIndex((npc) => npc.attendee === participant.identity);
  const isAi = aiIndex >= 0;
  const humanSpeaking = useIsSpeaking(participant);
  const speechState = isAi ? undefined : speechStatus.participants[participant.identity]?.state;
  const speaking = isAi
    ? npcState.kind === 'speaking' && npcState.speaker === participant.identity
    : humanSpeaking;
  const speakerAliases = isAi
    ? []
    : [participant.name ?? '', participant.identity, 'Guest'].filter((s) => s.trim().length > 0);
  const attendee = isAi ? scenario.attendees.find((candidate) => candidate.name === participant.identity) : undefined;
  const participantRole = isAi ? attendee?.role : participant.metadata?.trim() || undefined;
  const recognizedCaption = captionFor(
    chunks,
    transcriptNameFor(scenario, participant),
    now,
    isAi ? 8000 : 10000,
    speaking,
    speakerAliases,
    participantRole,
  );
  const caption =
    !isAi && humanSpeaking
      ? '🎙️ Speaking…'
      : !isAi && speechState === 'transcribing'
        ? '⏳ Transcribing…'
        : !isAi && speechState === 'failed'
          ? '⚠️ Kaki could not hear that — please repeat or type it'
          : recognizedCaption;
  const thinking = isAi && npcState.kind === 'thinking';
  const state = speaking ? 'speaking' : thinking ? 'thinking' : 'idle';
  const roleTitle = isAi
    ? scenario.roles.find((role) => role.id === attendee?.role)?.label
    : participantRole === undefined
      ? undefined
      : scenario.roles.find((role) => role.id === participantRole)?.label ?? participantRole;
  const avatarInfo =
    !isAi && avatars !== undefined
      ? avatars.get(participant.identity.trim().toLowerCase()) ??
        (participant.metadata === undefined || participant.metadata.trim() === ''
          ? undefined
          : avatars.get(participant.metadata.trim().toLowerCase()))
      : undefined;
  const displayName = avatarInfo?.displayName ?? (participant.name || participant.identity);
  // Never repeat a role whose label is already the person's display name.
  const shownRoleTitle = roleTitle === displayName ? undefined : roleTitle;
  const stance = isAi && attendee !== undefined
    ? colleagueStance(scenario, attendee.name)
    : undefined;
  const reaction = offTheRecord
    ? undefined
    : isAi
      ? reactionForColleague(participant.identity, events, now)
      : undefined;

  return (
    <div className="kd-tile" data-state={state} data-ai={isAi} data-speech={speechState ?? 'none'} data-identity={participant.identity} style={{ ['--c' as string]: `var(${orbPalette(isAi ? aiIndex : 1)[0]})` }}>
      {isAi ? <Orb state={state} palette={orbPalette(aiIndex)} /> : <ParticipantTile style={{ width: '100%', height: '100%' }} />}
      <div className="kd-who">
        {isAi ? <i /> : <Avatar name={displayName} photoUrl={avatarInfo?.photoUrl} size="sm" />}
        <div className="kd-who-text">
          <div className="kd-who-line">
            <span>{isAi ? participant.identity : `${displayName}${isYou ? ' (You)' : ''}`}</span>
            {shownRoleTitle !== undefined && <small className="kd-who-role">· {shownRoleTitle}</small>}
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
      {!offTheRecord && caption !== null && (
        <div key={caption} className="kd-caption">
          {caption}
        </div>
      )}
    </div>
  );
}
