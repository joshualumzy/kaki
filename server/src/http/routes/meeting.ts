import { randomUUID } from 'node:crypto';
import {
  codeProblem,
  humanAttendeeForRole,
  isHumanParticipant,
  isKakiListener,
  joinSeatRoles,
  KAKI_LISTENER_IDENTITY,
  NO_TEAM_MEETING_MESSAGE,
  seatProblem,
  speakerName,
  type MeetingSetup,
  type Scenario,
} from '@kaki/shared';
import { clientAddress, publicUrlIsHttps } from '../access';
import { MAX_BODY_BYTES, PRACTICE_COOKIE, type RouteCall } from '../routeCall';
import { readJsonBody, sendJson } from '../http';
import { MEETING_CODE_RATE_LIMIT_MESSAGE } from '../../meeting/meetingCode';
import { admission, type Admission } from '../../meeting/rejoin';
import { createRoomToken, joinNameProblem, JoinError, livekitPublicUrl } from '../../services/livekit';
import { SAMPLE_WORKSPACE_ID } from '../../workspace/constants';

/** The one message for a role id this meeting does not offer: name it and list the offered seats. */
function notAHumanSeat(wanted: string, offered: ReadonlyArray<{ id: string; label: string }>): string {
  const list =
    offered.length === 0 ? 'none' : offered.map((role) => `${role.id} (${role.label})`).join(', ');
  return `"${wanted}" is not a human seat in this meeting. Pick one of the roles offered when you join: ${list}.`;
}

/** The one practice refusal while a real meeting is open or running. */
const REAL_IN_PROGRESS_MESSAGE = 'A team meeting is in progress right now. Try practice again later.';

function practiceCookie(token: string): string {
  const secure = publicUrlIsHttps() ? '; Secure' : '';
  return `${PRACTICE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

async function syncDemoVisitorProfile(participantName: string): Promise<void> {
  const cleanName = speakerName(participantName);
  if (cleanName === '') return;

  const giteaUrl = process.env.GITEA_URL?.trim();
  const giteaToken = process.env.GITEA_TOKEN?.trim();
  if (giteaUrl && giteaToken) {
    await fetch(`${giteaUrl.replace(/\/+$/, '')}/api/v1/admin/users/demo`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `token ${giteaToken}` },
      body: JSON.stringify({ full_name: cleanName, login_name: 'demo' }),
    }).catch(() => undefined);
  }

  const mmUrl = process.env.MATTERMOST_URL?.trim();
  const mmPassword = process.env.MATTERMOST_PASSWORD;
  if (mmUrl && mmPassword) {
    try {
      const baseMmUrl = mmUrl.replace(/\/+$/, '');
      const mmAdminToken = process.env.MATTERMOST_TOKEN?.trim();
      if (mmAdminToken) {
        await fetch(`${baseMmUrl}/api/v4/config/patch`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${mmAdminToken}` },
          body: JSON.stringify({ TeamSettings: { TeammateNameDisplay: 'full_name', LockTeammateNameDisplay: true } }),
        }).catch(() => undefined);
      }
      let loginResp: Response | undefined;
      for (const loginId of ['demo@nanyangkopitiam.example', 'demo']) {
        const resp = await fetch(`${baseMmUrl}/api/v4/users/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ login_id: loginId, password: mmPassword }),
        });
        if (resp.ok) {
          loginResp = resp;
          break;
        }
      }
      if (loginResp?.ok) {
        const sessionToken = loginResp.headers.get('Token');
        const userObj = (await loginResp.json().catch(() => undefined)) as { id?: string } | undefined;
        if (sessionToken && userObj?.id) {
          await fetch(`${baseMmUrl}/api/v4/users/${userObj.id}/patch`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
            body: JSON.stringify({ username: 'demo', first_name: cleanName, last_name: '', nickname: cleanName }),
          }).catch(() => undefined);
        }
      }
    } catch {
      // Best-effort profile sync when visitor joins.
    }
  }
}

/** Issues a LiveKit join token after the meeting code and seat admission checks. */
export async function handleLivekitToken(call: RouteCall): Promise<void> {
  const { request, response, context, principal } = call;
  const codeIp = clientAddress(request);
  if (context.meetingCodeAttempts.isLimited(codeIp)) {
    sendJson(response, 429, { error: MEETING_CODE_RATE_LIMIT_MESSAGE });
    return;
  }
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    sendJson(response, body.status, { error: body.error });
    return;
  }
  const join = body.value as Record<string, unknown> | null;
  if (
    typeof join !== 'object' ||
    join === null ||
    typeof join.participantName !== 'string' ||
    (join.participantRole !== undefined && typeof join.participantRole !== 'string')
  ) {
    sendJson(response, 400, { error: 'participantName is required' });
    return;
  }
  const participantName = join.participantName.trim();
  const wantedRole = typeof join.participantRole === 'string' ? join.participantRole.trim() : '';
  if (wantedRole.length === 0) {
    sendJson(response, 400, { error: 'participantRole is required: pick the seat you are taking.' });
    return;
  }
  // A plain join is a team-meeting join. A practice join is one anonymous visitor with the demo
  // colleagues, and is refused while a real meeting is open or running.
  const requestedKind = join.kind;
  if (requestedKind !== undefined && requestedKind !== 'real' && requestedKind !== 'practice') {
    sendJson(response, 400, { error: "kind must be 'real' or 'practice'." });
    return;
  }
  const wantsPractice = requestedKind === 'practice';
  // No legacy join: a team-meeting join exists only after the owner has opened a real meeting.
  if (!wantsPractice && context.session.kind() !== 'real') {
    sendJson(response, 409, { error: NO_TEAM_MEETING_MESSAGE });
    return;
  }
  if (
    wantsPractice &&
    (context.session.kind() === 'real' || context.session.reviewingEndedTeamMeeting())
  ) {
    sendJson(response, 409, { error: REAL_IN_PROGRESS_MESSAGE, realInProgress: true });
    return;
  }
  // A meeting being prepared is sealed already: admitting someone now would leave their seat out.
  if (context.session.phase() === 'starting') {
    sendJson(response, 409, {
      error: 'The meeting is starting; try again in a moment.',
      retryable: true,
    });
    return;
  }
  try {
    await context.admit(async () => {
      // A Start flips the phase inside this same queue: this catches a join that queued behind it.
      if (context.session.phase() === 'starting') {
        sendJson(response, 409, {
          error: 'The meeting is starting; try again in a moment.',
          retryable: true,
        });
        return;
      }
      const admissionPhase = context.session.phase();
      const admissionGeneration = context.session.generation();
      // The identity this admission is against. The room, token and committed meeting all
      // follow the identity that exists after any reset below, never one read before the queue.
      const admissionMeetingId = context.meeting.id;
      // Re-check the journey inside the queue: an owner open that landed while this join waited
      // must not let a team join into a practice meeting, or a practice join into a real one.
      if (!wantsPractice && context.session.kind() !== 'real') {
        sendJson(response, 409, { error: NO_TEAM_MEETING_MESSAGE });
        return;
      }
      if (
        wantsPractice &&
        (context.session.kind() === 'real' || context.session.reviewingEndedTeamMeeting())
      ) {
        sendJson(response, 409, { error: REAL_IN_PROGRESS_MESSAGE, realInProgress: true });
        return;
      }
      // An unauthenticated same-name request is a competing admission, not a retry. Only the
      // existing practice capability may reclaim the visitor's own reservation.
      const hasPracticeCapability =
        wantsPractice && context.practicePrincipal(request) !== undefined;
      // Practice runs one visitor at a time. A different visitor arriving while it is starting or
      // running waits, and is told when it frees up, instead of being left to guess.
      if (wantsPractice && !hasPracticeCapability && context.practiceBusy()) {
        sendJson(response, 409, {
          error: 'practice-busy',
          message:
            'Someone is using the practice meeting right now. It frees up when they finish, usually within 15 minutes.',
        });
        return;
      }
      // Admission reads the pack, not the sealed cast: a seat an AI once had stays a reserved name.
      const npcNames = (context.fullScenario.npcs ?? []).map((npc) => npc.attendee);
      const reservedNames = [...npcNames, KAKI_LISTENER_IDENTITY];
      const joiningName = participantName.toLowerCase();
      // The room the decision is about is the one people are actually in right now.
      const rosterRoom = context.roomName();
      const roster = await context.roomRoster(rosterRoom);
      if (roster === undefined) {
        sendJson(response, 503, {
          error: 'Could not check who is in the meeting right now. Try again in a moment.',
          retryable: true,
        });
        return;
      }
      // The runner's technical listener sits in every room but is never a person in the meeting.
      const rosterHumans = roster.filter((person) => isHumanParticipant(person.name, npcNames));
      // A reservation made by this same person is a retry, not another seat: let them reclaim it.
      // A practice join without the capability does not get that grace: it competes for the seat.
      const mayReclaimName = !wantsPractice || hasPracticeCapability;
      const otherReservations = context.reservations
        .active(rosterHumans.map((person) => person.name))
        .filter(
          (reservation) =>
            !mayReclaimName || reservation.participantName.toLowerCase() !== joiningName,
        );
      // A practice meeting is its own room. People still listed in another meeting's room (an
      // ended team meeting kept open for the minutes) neither take its one seat nor make it the
      // meeting this visitor joins; only an existing practice meeting competes for its seat.
      const practiceStartsFresh = wantsPractice && context.session.kind() !== 'practice';
      const present = practiceStartsFresh
        ? []
        : [
            ...rosterHumans,
            ...otherReservations.map((reservation) => ({ name: reservation.participantName, role: reservation.seatId })),
          ];
      // Every refusal happens before anything can reset or mutate the meeting. With sign-in on,
      // a person needs the code; the signed-in owner may start or carry on a meeting without it.
      const authOn = context.auth !== undefined;
      const isHost = principal.kind === 'host';
      if (authOn && principal.kind !== 'service' && !isHost && !wantsPractice) {
        const codeError = codeProblem(
          1,
          context.meetingCode.value,
          typeof join.meetingCode === 'string' ? join.meetingCode : undefined,
        );
        if (codeError !== undefined) {
          context.meetingCodeAttempts.recordFailure(codeIp);
          sendJson(response, 403, { error: codeError, needsCode: true });
          return;
        }
      }
      // A seat holder coming back to an empty room inside the grace joins the running meeting;
      // everyone else starts the next meeting, which is judged against the current draft.
      const roomEmpty = present.length === 0;
      const phase = admissionPhase;
      // A saved meeting that did not come back running is consumed: the next arrival starts fresh,
      // even if the person's name was one of its holders.
      const decisionPhase = context.session.restoredWithoutMeeting() ? 'ended' : phase;
      const holders = context.session.holders();
      const abandoned = context.session.abandoned();
      const wouldHold = context.rejoin.wouldHold();
      // A practice meeting decides its own return below: a name alone never resumes it when
      // sign-in is on. The team path keeps its existing name/holder rule.
      const returning =
        !wantsPractice &&
        roomEmpty &&
        admission({
          phase: decisionPhase,
          holders,
          present,
          name: participantName,
          graceActive: wouldHold,
          abandoned,
        }) === 'resume';
      const seating: {
        scenario: Scenario;
        admissionScenario: Scenario;
        setup?: MeetingSetup;
        admissionCap?: number;
      } = wantsPractice
        ? { scenario: context.fullScenario, admissionScenario: context.fullScenario }
        : context.seating(returning, roomEmpty);
      // The role id is the seat's one identity. An owner-edited draft admits only the person seats
      // it names; an untouched draft admits every human seat the pack offers.
      let seatId: string;
      if (!wantsPractice && seating.setup !== undefined) {
        const key = wantedRole.toLowerCase();
        const role = seating.setup.roles.find((candidate) => candidate.id.toLowerCase() === key);
        if (role === undefined) {
          sendJson(response, 400, {
            error: notAHumanSeat(wantedRole, joinSeatRoles(seating.scenario)),
          });
          return;
        }
        const isPersonSeat = seating.setup.seats.some(
          (candidate) => candidate.kind === 'person' && candidate.roleId === role.id,
        );
        if (!isPersonSeat) {
          sendJson(response, 409, {
            error: `This meeting's setup has no place for ${role.label}; the owner set the seats.`,
          });
          return;
        }
        seatId = role.id;
      } else {
        const seat = humanAttendeeForRole(seating.admissionScenario, wantedRole);
        if (seat === undefined) {
          sendJson(response, 400, {
            error: notAHumanSeat(wantedRole, joinSeatRoles(seating.scenario)),
          });
          return;
        }
        seatId = seat.role;
      }
      // The only way to resume or replace a practice seat is the current capability for the
      // exact seat it was granted. A wrong seat is refused; a name alone is a new meeting.
      const practiceStrict = wantsPractice && authOn;
      if (practiceStrict && hasPracticeCapability) {
        const practiceSeat = context.session.practiceSeat();
        if (
          practiceSeat === undefined ||
          practiceSeat.trim().toLowerCase() !== seatId.trim().toLowerCase()
        ) {
          sendJson(response, 403, {
            error: 'Practice access belongs to the seat its visitor took.',
          });
          return;
        }
      }
      // The owner just opened this lobby and nobody is seated yet: the first friend with the
      // code joins it — a reset here would wipe the meeting under the owner's feet.
      const openedLobbyJoin =
        roomEmpty &&
        !wantsPractice &&
        decisionPhase === 'lobby' &&
        holders.length === 0 &&
        context.session.kind() === 'real';
      const decision: Admission = roomEmpty
        ? practiceStrict
          ? decisionPhase === 'ended' || abandoned || !wouldHold
            ? 'reset'
            : hasPracticeCapability
              ? 'resume'
              : 'reset'
          : openedLobbyJoin
            ? 'join'
            : admission({
                phase: decisionPhase,
                holders,
                present,
                name: participantName,
                seat: seatId,
                graceActive: wouldHold,
                abandoned,
              })
        : 'join';
      const requestedMax = Number(process.env.NPC_MAX_HUMANS);
      const envMax = Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : undefined;
      // A setup admits exactly its own person seats; an AI meeting still caps at one person in seatProblem.
      const setupMax = seating.admissionCap;
      const maxHumans = setupMax === undefined ? envMax : Math.min(setupMax, envMax ?? setupMax);
      const problem = seatProblem(seating.admissionScenario, present, seatId, maxHumans);
      if (problem !== undefined) {
        sendJson(response, 409, { error: problem });
        return;
      }
      if (!authOn && !wantsPractice) {
        // The trusted demo keeps its first-arrival rule exactly: the first person is shown the code.
        // `present` is read before any reset, so this stays the count from this room.
        const codeError = codeProblem(
          present.length,
          context.meetingCode.value,
          typeof join.meetingCode === 'string' ? join.meetingCode : undefined,
        );
        if (codeError !== undefined) {
          context.meetingCodeAttempts.recordFailure(codeIp);
          sendJson(response, 403, { error: codeError, needsCode: true });
          return;
        }
      }
      context.meetingCodeAttempts.clear(codeIp);
      // The first person into an empty room starts a new meeting with a new code; later people must know it.
      // A person returning within the grace window keeps the meeting, its code, agenda, tasks and NPC conversation;
      // a different person arriving in that empty room starts a fresh meeting instead.
      const meetingWasRunning = phase === 'running';
      const meetingExisted = context.session.restoredWithoutMeeting()
        ? false
        : holders.length > 0 || phase === 'running' || phase === 'ended';
      // A code holder may be first into a fresh meeting, but may never wipe one that already ran.
      // That holds for an abandoned meeting too: it never resumes, and only the owner replaces it.
      // A practice visitor may replace their own finished practice meeting; kind 'real' was
      // refused above, so this can never wipe the owner's real meeting.
      const wouldReset = decision === 'reset';
      if (wouldReset && meetingExisted && authOn && !isHost && !wantsPractice) {
        sendJson(response, 409, {
          error: 'This meeting has ended; the meeting owner must start the next one.',
        });
        return;
      }
      if (
        !hasPracticeCapability &&
        present.some((person) => person.name.toLowerCase() === joiningName)
      ) {
        sendJson(response, 409, {
          error: `"${participantName}" is already in the meeting. Pick another name.`,
        });
        return;
      }
      // Refuse a bad display name before anything can reset the meeting.
      if (isKakiListener(participantName)) {
        throw new JoinError(`"${participantName}" is reserved for the meeting listener; pick another name`);
      }
      const nameProblem = joinNameProblem(participantName, reservedNames);
      if (nameProblem !== undefined) throw new JoinError(nameProblem);

      // A Start or reset that landed while this join awaited the roster must not let it
      // mutate a meeting it never saw: refuse before any reset or seat claim, and let the client retry.
      if (
        context.session.generation() !== admissionGeneration ||
        context.session.phase() !== admissionPhase ||
        context.meeting.id !== admissionMeetingId
      ) {
        sendJson(response, 409, {
          error: 'The meeting changed while you were joining; try again in a moment.',
          retryable: true,
        });
        return;
      }

      // A practice visitor carrying the current capability may rejoin the practice meeting it
      // already holds; that is not a new meeting and must not replace the capability.
      const joinsAsPracticeRetry =
        wantsPractice &&
        hasPracticeCapability &&
        decision !== 'reset' &&
        context.session.kind() === 'practice';

      // All checks passed: this is the commit. Admission decides, the session resets if needed,
      // and everything below belongs to the identity that exists after that reset.
      if (decision === 'reset') {
        // The first arrival starts this app's first meeting. Its identity already exists, and
        // phones may have joined under it through /api/join, so keep that generation and code.
        context.session.reset({
          seat: seatId,
          rotateIdentity: meetingExisted,
          rotateCode: true,
        });
      } else if (openedLobbyJoin) {
        // The first person into the opened lobby picks the agenda for their seat, exactly as
        // the reset they replaced used to shape it — without resetting the meeting itself.
        context.shapeLobbyFor(seatId);
      }
      // Record which journey opened this meeting. A practice visitor gets the Start capability
      // for this meeting only; a real meeting is the owner's, with no practice power at all.
      if (wantsPractice) {
        if (!joinsAsPracticeRetry) {
          const practiceToken = authOn ? randomUUID() : undefined;
          context.session.beginPractice({
            seat: seatId,
            ...(practiceToken === undefined ? {} : { token: practiceToken }),
          });
          if (practiceToken !== undefined) response.setHeader('set-cookie', practiceCookie(practiceToken));
        }
      } else if (context.session.kind() !== 'practice') {
        context.session.setKind('real');
      }
      // The identity this join enters is now final: pin it and re-check after every await below.
      // A lifecycle change that still slipped past the queue must refuse this join, never let it
      // hand out a token for the old room or claim a seat in the replacement meeting.
      const committedMeetingId = context.meeting.id;
      const committedGeneration = context.session.generation();
      const committedPhase = context.session.phase();
      const identityMoved = (): boolean =>
        context.meeting.id !== committedMeetingId ||
        context.session.generation() !== committedGeneration ||
        context.session.phase() !== committedPhase;
      const refuseMovedMeeting = (): void => {
        sendJson(response, 409, {
          error: 'The meeting changed while you were joining; try again in a moment.',
          retryable: true,
        });
      };
      const roomName = context.roomNameFor(committedMeetingId);
      const token = await createRoomToken(
        { roomName, participantName, participantRole: seatId },
        reservedNames,
      );
      if (identityMoved()) {
        refuseMovedMeeting();
        return;
      }
      if (roomEmpty && decision !== 'reset') context.rejoin.beginGrace();
      // Sign-in on: taking the seat and creating its session is one atomic claim shared with
      // /api/join, so a code holder can never take a seat another live holder owns. A practice
      // visitor never gets a sign-in session; their cookie carries only the Start capability.
      if (context.auth !== undefined && principal.kind !== 'service' && !wantsPractice) {
        if (!(await context.auth.enterSeat(request, response, seatId, committedMeetingId))) {
          console.error(
            `kaki join: ${participantName} could not take seat ${seatId} after the meeting reset; the seat is already held`,
          );
          sendJson(response, 409, { error: 'That seat is taken. Pick another role.' });
          return;
        }
        // The claim itself is an await: if the meeting moved, this seat belongs to its old identity.
        if (identityMoved()) {
          refuseMovedMeeting();
          return;
        }
      }
      context.reservations.add({ participantName, seatId });
      context.session.addHolder({ name: participantName, seat: seatId });
      context.runnerStateChanged();
      if (roomEmpty) context.rejoin.joined();
      else context.rejoin.occupied();
      // Seat holders are part of the meeting: save them so a restart recognises the same people.
      context.scheduleSave();
      context.watchRoom(roomName);
      // The demo profiles belong to the sample workspace only; a real meeting's people are their own.
      if (context.workspaceId === SAMPLE_WORKSPACE_ID) {
        void syncDemoVisitorProfile(participantName);
      }
      const resumed = meetingWasRunning && decision !== 'reset';
      const started = context.session.phase() === 'running';
      console.log(`[join] seat=${seatId} room=${roomName} reset=${decision === 'reset'} resumed=${resumed} started=${started}`);
      sendJson(response, 200, {
        token,
        url: livekitPublicUrl(),
        // A practice meeting has one visitor: its code must never travel to another seat.
        ...(wantsPractice ? {} : { meetingCode: context.meetingCode.value }),
        resumed,
        started,
      });
    });
  } catch (error) {
    if (error instanceof JoinError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    throw error;
  }
  return;
}

/** Starts the meeting once, letting a practice visitor start only its own practice meeting. */
export async function handleMeetingStart(call: RouteCall): Promise<void> {
  const { response, context, principal } = call;
  // One server-owned start for the whole meeting. A second Start is a no-op: it must never open the
  // meeting twice or restart the agenda clock. Every client learns the change from MEETING_STARTED.
  // The access layer let a practice visitor through; it must be the practice meeting still.
  if (principal.kind === 'practice' && context.session.kind() !== 'practice') {
    sendJson(response, 403, { error: 'Practice access has ended with its practice meeting.' });
    return;
  }
  const outcome = await context.startMeeting(principal.kind === 'practice');
  sendJson(response, outcome.status, outcome.body);
  return;
}

/** Opens the team meeting from the current draft and blocks practice until it ends. */
export async function handleMeetingOpen(call: RouteCall): Promise<void> {
  const { response, context } = call;
  // The owner opens the team meeting: the current draft is its plan, and it blocks practice
  // until it is over. Serialized with joins and Start so a practice admission cannot slip in.
  const outcome = await context.admit(async () => {
    const phase = context.session.phase();
    const kind = context.session.kind();
    const practiceInProgress =
      kind === 'practice' &&
      (context.session.holders().length > 0 || phase === 'running' || phase === 'starting');
    if (practiceInProgress) {
      return {
        status: 409,
        body: {
          error: 'A practice meeting is in progress right now. End it before opening the team meeting.',
          practiceInProgress: true,
        },
      };
    }
    if (phase === 'starting') {
      return { status: 409, body: { error: 'The meeting is starting; try again in a moment.', retryable: true } };
    }
    if (phase === 'running' && !context.session.abandoned()) {
      return {
        status: 409,
        body: { error: 'This meeting has already started. It cannot be opened again until it ends.' },
      };
    }
    // A practice meeting (even an abandoned, holder-free lobby) is consumed by opening a real
    // one: reset it so the practice generation, room and capability all move on. An ended or
    // abandoned meeting is consumed too.
    if (
      kind === 'practice' ||
      phase === 'ended' ||
      (phase === 'running' && context.session.abandoned())
    ) {
      context.session.reset();
    }
    context.session.setKind('real');
    // Freeze the plan people may see from now on: later draft edits are the next meeting's.
    context.captureLobbySnapshot();
    context.runnerStateChanged();
    context.scheduleSave();
    return { status: 200, body: { kind: 'real', phase: context.session.phase() } };
  });
  sendJson(response, outcome.status, outcome.body);
  return;
}

/** Closes an unstarted team room, or an ended one under review, and frees the server for practice. */
export async function handleMeetingClose(call: RouteCall): Promise<void> {
  const { response, context } = call;
  // The owner closes a real meeting room that never started. It releases the server for practice
  // without inventing a timer; closing rotates the identity, so its old room and tokens are gone.
  const outcome = await context.admit(async () => {
    // An ended team meeting can be closed once the owner is done reviewing its minutes. That is
    // the explicit way to release the server for practice before the empty-room expiry. The
    // review is the authority, not the saved phase: a restart restores both, but a review that
    // is still open must never depend on which phase a save happened to carry.
    const endedReview = context.session.reviewingEndedTeamMeeting();
    if (context.session.kind() !== 'real' && !endedReview) {
      return { status: 409, body: { error: 'There is no team meeting room open to close.' } };
    }
    if (context.session.phase() !== 'lobby' && !endedReview) {
      return {
        status: 409,
        body: { error: 'This meeting has already started. End it instead of closing the room.' },
      };
    }
    context.session.reset();
    context.runnerStateChanged();
    context.scheduleSave();
    return { status: 200, body: { ok: true, phase: context.session.phase() } };
  });
  sendJson(response, outcome.status, outcome.body);
  return;
}

/** Ends the practice meeting and frees the server for the team meeting. */
export async function handleMeetingEndPractice(call: RouteCall): Promise<void> {
  const { response, context } = call;
  // End a practice meeting and free the server for the team meeting. This is the existing
  // New-meeting reset path: identity, holders, retained events and saved state all move on.
  const outcome = await context.admit(async () => {
    if (context.session.kind() !== 'practice') {
      return { status: 409, body: { error: 'There is no practice meeting in progress to end.' } };
    }
    context.session.reset();
    context.runnerStateChanged();
    context.scheduleSave();
    return { status: 200, body: { ok: true, phase: context.session.phase() } };
  });
  sendJson(response, outcome.status, outcome.body);
  return;
}

/** Returns the meeting code to the owner's lobby and shared screen. */
export async function handleMeetingCode(call: RouteCall): Promise<void> {
  const { response, context } = call;
  // The meeting code is owner-only, whether or not sign-in is configured: the owner's lobby and
  // the shared screen need it in both modes, and the access check above already enforced it.
  sendJson(response, 200, { code: context.meetingCode.value });
  return;
}

/** Returns the people currently holding seats, for the owner only. */
export async function handleMeetingParticipants(call: RouteCall): Promise<void> {
  const { response, context } = call;
  // Who has joined is owner-only: the public state must not expose participant names.
  sendJson(response, 200, {
    participants: context.session.holders().map((holder) => ({ name: holder.name, seat: holder.seat })),
  });
  return;
}

/** Serves the lifecycle marker to browsers and the full runner snapshot to the runner. */
export async function handleMeetingState(call: RouteCall): Promise<void> {
  const { response, context, path } = call;
  // Browsers only need the lifecycle marker; the runner gets the one full meeting snapshot.
  if (path === '/api/runner/meeting-state') {
    sendJson(response, 200, context.runnerStateChanged());
    return;
  }
  sendJson(response, 200, {
    meetingId: context.meeting.id,
    started: context.session.phase() === 'running',
    ...(context.session.kind() === undefined ? {} : { kind: context.session.kind() }),
  });
  return;
}

/** Answers the health check. */
export async function handleHealth(call: RouteCall): Promise<void> {
  const { response } = call;
  sendJson(response, 200, { ok: true });
  return;
}
