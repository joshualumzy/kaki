import type { Role } from './roles';
import type { ActionKind } from './task';

/** One role the active scenario defines, with the label people see. */
export interface ScenarioRole {
  id: Role;
  label: string;
  /**
   * The role that runs the meeting (for example Sam, the general manager). It is never counted as quiet or offered to a
   * participant. An AI plays it unless its attendee's npc is `playable`, which makes it the host mode seat.
   */
  facilitator?: boolean;
  /** What a person playing this role is told on their role card: facts, not a script. */
  card?: RoleCard;
  /**
   * A few words for what this seat stands for, shown on the meeting tile. Optional: a scenario
   * without one shows no stance rather than inventing copy.
   */
  stance?: string;
}

/** A short, open-ended briefing for the person playing a role in the live demo meeting. */
export interface RoleCard {
  /** Who they are and what the meeting is for, in a sentence. */
  youAre: string;
  /** Things they know from their side of the company. */
  facts: string[];
  /** What they are answerable for. */
  responsibility: string;
}

/** A participant joining the meeting, with the name the meeting shows for them. */
export interface Attendee {
  name: string;
  role: Role;
  displayName: string;
  /** A few plain words for their job, said after their name when the host introduces them, for example "on tills and tech". */
  spokenJob?: string;
}

/** One agenda item with its time limit and the role that owns it. */
export interface AgendaItem {
  title: string;
  minutes: number;
  /** Whether this item's decision can be deferred to a later slot, or has to be made now; required by validation. */
  canWait: boolean;
  /** When the decision has to be made, said aloud in plain words ("before doors open at 8"); required by validation. */
  deadline: string;
  ownerRole: Role;
  /** The call this item exists to get, as a question to the person who decides ("Do we ship as is, or hold the date?"); optional. */
  decision?: string;
  /** The characters disagree on this item, so the person is asked to settle it; optional. */
  contested?: boolean;
  /** Structured opening angles and trade-offs the AI colleagues can draw on; optional. */
  discussion?: AgendaDiscussion;
  /** What the room is told at the start, split into facts so only the colleagues who would know each one say it. */
  briefing?: BriefingFact[];
  /** Short name used when the host refers to the item aloud, e.g. "the food safety complaint". */
  spoken?: string;
  /** Artwork for this item, if the scenario provides it. */
  art?: string;
  /** Hidden possible directions for this topic: background for the AI, never a menu read aloud. */
  directions?: string[];
  /** Facts tied to this topic that every colleague may use, such as established facts. */
  background?: string[];
  /** A sensitive item calls for a serious, respectful tone. */
  sensitive?: boolean;
  /** A person outside the meeting who can answer once in this topic, when a colleague says they will ask. */
  offScreen?: AgendaOffScreen;
  /** Each seat's one fact for this topic, keyed by role id. */
  seatFacts?: Record<string, string>;
  /** Other topics this one links to, with one sentence on what carries across. */
  links?: AgendaLink[];
  /** Figures that may be spoken exactly; other numbers are spoken loosely. */
  sayExactly?: string[];
  /** Default follow-up when the Director does not suggest a valid one. */
  followUp?: { kind: ActionKind; hint: string };
}

/** Someone outside the meeting who answers at most once in their topic. */
interface AgendaOffScreen {
  name: string;
  role: string;
  /** How they answer, and the one condition that shapes it. */
  howTheyAnswer: string;
}

/** A link from this agenda item to another one. */
interface AgendaLink {
  /** The title of the other agenda item. */
  with: string;
  /** What carries from one topic to the other. */
  effect: string;
}

/**
 * What the AI colleagues bring to one agenda item: each speaker's opening angle and the distinct
 * trade-offs that keep the decision open. It is data, not a script: it names what is at stake and
 * the question still to answer, never the solution or a required number of turns.
 */
interface AgendaDiscussion {
  /** What each colleague cares about at the start of the item, as an angle, never a line to read aloud. */
  openingViews: AgendaOpeningView[];
  /** The distinct tensions the person deciding must weigh. */
  tradeOffs: AgendaTradeOff[];
}

/** One colleague's opening angle on an agenda item. */
interface AgendaOpeningView {
  /** The `name` of the attendee whose angle this is. */
  attendee: string;
  /** What that person cares about on this item, as a short phrase, never a line to read aloud. */
  angle: string;
}

/** One thing the room is told at the start of a topic, and the colleagues who would actually know it. */
interface BriefingFact {
  /** What happened, as one short spoken fact. */
  text: string;
  /**
   * Who knows it, best-placed knower first. The first present colleague who is not the guest or the host tells it,
   * and their `why` is the reason Sam gives when handing over.
   */
  knownBy: BriefingFactKnower[];
}

/** A colleague who knows a briefing fact, and why it is theirs to tell. */
interface BriefingFactKnower {
  /** The `name` of the attendee who knows it. */
  attendee: string;
  /** Why this person knows, said after their name, for example "you went through the fridge log". */
  why: string;
}

/** One distinct trade-off the room wants the person deciding to weigh. */
interface AgendaTradeOff {
  /** The `name` of the attendee who raises this trade-off. */
  attendee: string;
  /** The role whose work or obligation makes this trade-off matter. */
  role: Role;
  /** The guest idea this catch reacts to, in a few plain words. */
  idea: string;
  /** What is at stake, grounded in the company records. */
  tradeOff: string;
  /** The open question the colleague should ask next. */
  question: string;
}

/**
 * An AI attendee in the live demo meeting: one of the scenario's attendees played by the NPC
 * director. The profile is what makes the character a person with their own aims, not a mouthpiece.
 */
export interface NpcProfile {
  /** The `name` of the attendee this character plays. */
  attendee: string;
  /** Text-to-speech voice, for example "en-US-DavisNeural". */
  voice: string;
  /** How they talk and act, in a sentence or two. */
  personality: string;
  /** What they want out of this meeting. */
  agenda: string;
  /** Things they worry about and will raise or push back on. */
  concerns: string[];
  /** Facts they know and can state; optional. */
  knows?: string[];
  /** Words speech recognition tends to hear instead of their name, for example "Archer" for "Arjun". */
  soundsLike?: string[];
  /**
   * A person may take this attendee's seat. The character is played by the AI only when nobody
   * picks it, so the AI attendees of a session are the profiles minus the person's seat.
   */
  playable?: boolean;
  /** How they treat a person in each role (keyed by role id), for example a boss or a peer. */
  withRoles?: Record<string, string>;
  /** Part they play in the meeting: the host runs it, observers only speak when addressed or relevant. */
  role?: NpcRole;
  /** How they sound: sentence length, verbal habits, how they hedge or push back. */
  speechStyle?: string;
  /** How they meet a cost or a push, such as giving way on people but not on untested systems. */
  temperament?: string;
  /** What they personally stand to lose or protect this morning. */
  stake?: string;
  /** What they want but would not say outright. */
  hiddenGoal?: string;
  /** Standing disagreements with other characters, which give them a reason to answer each other. */
  tensions?: NpcTension[];
}

/** How an NPC attends: chairing the meeting, taking part, or watching only. */
export type NpcRole = 'host' | 'participant' | 'observer';

/** A standing disagreement between this character and another attendee. */
interface NpcTension {
  /** The `name` of the other attendee. */
  with: string;
  /** What they disagree about, from this character's point of view. */
  about: string;
}

/** The meeting Kaki is set in: organisation, roles, people and agenda. */
export interface Scenario {
  id: string;
  /**
   * The team or company the meeting belongs to. Required in a demo pack file; absent in an
   * owner-written meeting whose organisation field was left blank.
   */
  organisation?: string;
  meetingTitle: string;
  roles: ScenarioRole[];
  attendees: Attendee[];
  agenda: AgendaItem[];
  /** What is going on and what the meeting is for, told to the AI attendees; optional. */
  situation?: string;
  /**
   * How the AI colleagues should sound (phrasing, dialect, words to avoid); optional. A demo pack
   * carries its own register; an owner-written meeting has none.
   */
  speechRegister?: string;
  /** Shared background every colleague knows, usable for invented details; optional. */
  background?: string[];
  /** Agenda titles that must never be drawn together in one meeting; optional. */
  excludedPairs?: [string, string][];
  /** Words and names likely to come up, so the AI attendees can tell what a misheard word was meant to be; optional. */
  vocabulary?: string[];
  /** Plain meanings of the team's own terms, so the characters can explain them to someone new; optional. */
  glossary?: Record<string, string>;
  /** AI attendees for the live demo meeting; absent when the scenario has none. */
  npcs?: NpcProfile[];
  /**
   * Role ids a person may join as right now. The server adds this before Start when the owner set the
   * seats; the join form lists only these roles. Absent means every human seat is open.
   */
  joinSeats?: string[];
  /** What a person hosting the meeting is told before they start; optional. */
  hostBrief?: HostBrief;
  /**
   * The story the practice briefing shows over the meeting stage. Optional: an owner-written
   * meeting without one gets neutral, scenario-derived copy and no pack artwork.
   */
  practiceBriefing?: PracticeBriefing;
}

/** The story shown on the start prompt before a practice meeting: artwork, badge and intro line. */
interface PracticeBriefing {
  /** Artwork for the briefing hero, if the scenario provides it, for example "/scenario/kopitiam-hero.svg". */
  heroArt?: string;
  /** The pill over the hero, for example "Nanyang Kopi & Toast · Opening day". */
  badge?: string;
  /** The story line under the hero; `{minutes}` becomes the meeting's total agenda minutes. */
  intro: string;
}

/** A short briefing for a person who runs the meeting. */
export interface HostBrief {
  /** What the meeting is for, in a sentence. */
  goal: string;
  /** The decision the meeting has to land by the end. */
  decision: string;
}

/** Role ids are lower-case words joined by underscores, starting with a letter. */
export const ROLE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
/** The role id kept for the shared room screen, so no person may take it. */
export const RESERVED_ROLE_ID = 'screen';
