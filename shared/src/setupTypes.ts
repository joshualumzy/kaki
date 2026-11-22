/** Where a group of setup fields came from, shown next to them on the setup screen. */
export type SetupSource = 'calendar invite' | 'demo pack' | 'typed';

/** One agenda item in the pre-Start setup. */
export interface MeetingSetupAgendaItem {
  id: string;
  title: string;
  minutes: number;
  /** The id of the role that owns this item. */
  ownerRoleId: string;
}

/** One role in the pre-Start setup. */
export interface MeetingSetupRole {
  id: string;
  label: string;
  /** Whether this role runs the meeting. */
  facilitator: boolean;
}

type MeetingSetupSeatKind = 'person' | 'ai';

/** One seat at the meeting, either a real person or an AI stand-in from the demo pack. */
export interface MeetingSetupSeat {
  displayName: string;
  roleId: string;
  kind: MeetingSetupSeatKind;
  /** The demo-pack NPC profile this AI seat plays; required when `kind` is `ai`. */
  npcProfileId?: string;
}

/**
 * The three Wingman nudge timings, in seconds (the nudge module's current constants):
 * quietCheckAfter is how far into an item Wingman checks whether its owner has spoken;
 * ownerQuietBelow is how little talk by then counts as quiet; comingUpBefore is how long
 * before an item ends the next item's owner is told they are up.
 */
export interface MeetingPace {
  ownerQuietBelow: number;
  quietCheckAfter: number;
  comingUpBefore: number;
}

/** Where each setup field's value came from, so the screen can label it. */
export interface MeetingSetupSources {
  title: SetupSource;
  agenda: SetupSource;
  roles: SetupSource;
  seats: SetupSource;
  pace: SetupSource;
}

/** The one authoritative meeting setup saved before Start. */
export interface MeetingSetup {
  title: string;
  /** The team or organisation the owner typed; absent when they left it blank. */
  organisation?: string;
  agenda: MeetingSetupAgendaItem[];
  roles: MeetingSetupRole[];
  seats: MeetingSetupSeat[];
  pace: MeetingPace;
  source: MeetingSetupSources;
}

/** One plain-language problem with the field named in `field`. */
export interface SetupFieldError {
  field: string;
  message: string;
}

/** The longest a single agenda item may be, in minutes. */
export const MAX_AGENDA_MINUTES = 240;

/** A team or organisation name is kept short enough to say and show beside the title. */
export const MAX_ORGANISATION_LENGTH = 120;

/** The pace used before the owner sets their own on the setup screen. */
export const DEFAULT_MEETING_PACE: MeetingPace = {
  ownerQuietBelow: 30,
  quietCheckAfter: 120,
  comingUpBefore: 60,
};
