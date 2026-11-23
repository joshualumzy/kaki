import {
  humanAttendeeForRole,
  isHumanParticipant,
  isKakiListener,
  joinSeatRoles,
  KAKI_LISTENER_IDENTITY,
  NO_TEAM_MEETING_MESSAGE,
  seatProblem,
  speakerName,
} from '@kaki/shared';
import { MAX_BODY_BYTES, type RouteCall } from '../routeCall';
import { readJsonBody, sendJson } from '../http';
import { createRoomToken, joinNameProblem, JoinError, livekitPublicUrl } from '../../services/livekit';
import { SAMPLE_WORKSPACE_ID } from '../../workspace/constants';
import { realPersonName, realSeatId } from '../../meeting/realMeeting';

/** The one message for a role id this meeting does not offer: name it and list the offered seats. */
function notAHumanSeat(wanted: string, offered: ReadonlyArray<{ id: string; label: string }>): string {
  const list =
    offered.length === 0 ? 'none' : offered.map((role) => `${role.id} (${role.label})`).join(', ');
  return `"${wanted}" is not a human seat in this meeting. Pick one of the roles offered when you join: ${list}.`;
}

const SAMPLE_GITEA_USER = 'demo';

async function syncDemoVisitorProfile(participantName: string): Promise<void> {
  const cleanName = speakerName(participantName);
  if (cleanName === '') return;

  const giteaUrl = process.env.GITEA_URL?.trim();
  const giteaToken = process.env.GITEA_TOKEN?.trim();
  if (giteaUrl && giteaToken) {
    await fetch(`${giteaUrl.replace(/\/+$/, '')}/api/v1/admin/users/${SAMPLE_GITEA_USER}`, {
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

/**
 * Join a real product meeting: no role picker and no typed code. Each person takes a stable plain
 * seat under their own name, so a refresh or rejoin returns to the same seat and two people who
 * share a name both get in.
 */
async function handleRealLivekitToken(call: RouteCall): Promise<void> {
  const { request, response, context, principal } = call;
  const parsed = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    sendJson(response, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.value as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) {
    sendJson(response, 400, { error: 'Body must be a JSON object' });
    return;
  }
  const typedName = typeof body.participantName === 'string' ? body.participantName.trim() : '';
  if (body.kind === 'practice') {
    sendJson(response, 409, { error: 'This is a real meeting; practice has its own page.' });
    return;
  }
  // With sign-in on, a seat follows a signed-in person, a guest cookie or a held seat. A request with
  // none of them (such as a second join racing a rotated cookie) must not be given a seat by name.
  if (context.auth !== undefined && principal.kind === 'anonymous') {
    sendJson(response, 401, { error: 'Your session expired. Open the invite link again to join.' });
    return;
  }
  const name = realPersonName(principal, typedName);
  if (name === '') {
    sendJson(response, 400, { error: 'Your name is required to join this meeting.' });
    return;
  }
  const nameProblem = joinNameProblem(name, [KAKI_LISTENER_IDENTITY]);
  if (nameProblem !== undefined) {
    sendJson(response, 400, { error: nameProblem });
    return;
  }

  try {
    await context.admit(async () => {
      if (context.session.kind() !== 'real') {
        sendJson(response, 409, { error: NO_TEAM_MEETING_MESSAGE });
        return;
      }
      if (context.session.phase() === 'starting') {
        sendJson(response, 409, {
          error: 'The meeting is starting; try again in a moment.',
          retryable: true,
        });
        return;
      }
      const admissionPhase = context.session.phase();
      if (admissionPhase === 'ended') {
        sendJson(response, 409, { error: 'This meeting has ended.' });
        return;
      }
      const admissionGeneration = context.session.generation();
      const hadPeople = context.session.holders().length > 0;
      const meetingId = context.meeting.id;
      const identityMoved = (): boolean =>
        context.meeting.id !== meetingId || context.session.generation() !== admissionGeneration;
      const refuseMovedMeeting = (): void => {
        sendJson(response, 409, {
          error: 'The meeting changed while you were joining; try again in a moment.',
          retryable: true,
        });
      };
      const roomName = context.roomNameFor(meetingId);
      const seatId = realSeatId(principal, name, meetingId);
      // The person's Google photo, when they have an account; the room shows it beside their name.
      let photoUrl: string | undefined;
      let email: string | undefined;
      if (
        context.auth !== undefined &&
        (principal.kind === 'host' || principal.kind === 'user') &&
        principal.userId !== undefined
      ) {
        const user = await context.auth.store.findUserById(principal.userId);
        photoUrl = user?.picture ?? undefined;
        email = user?.email;
      }
      const token = await createRoomToken(
        {
          roomName,
          participantName: name,
          participantIdentity: seatId,
          participantRole: seatId,
        },
        [KAKI_LISTENER_IDENTITY],
      );
      if (identityMoved()) {
        refuseMovedMeeting();
        return;
      }
      if (context.auth !== undefined && principal.kind !== 'service') {
        const accountUserId =
          principal.kind === 'user' || principal.kind === 'host' || principal.kind === 'seat'
            ? principal.userId
            : undefined;
        let entered = await context.auth.enterSeat(request, response, seatId, meetingId);
        if (!entered && accountUserId !== undefined) {
          // The same signed-in person on a new browser still owns their seat: release the claim
          // held by their older session, then take the same seat again.
          const holder = await context.auth.store.seatHolder({ meetingId, role: seatId });
          const older = holder === undefined ? undefined : await context.auth.store.findSession(holder);
          if (holder !== undefined && older?.userId === accountUserId) {
            await context.auth.store.releaseSeats({ holder });
            entered = await context.auth.enterSeat(request, response, seatId, meetingId);
          }
        }
        if (!entered) {
          sendJson(response, 409, { error: 'That seat is taken. Pick another role.' });
          return;
        }
        // The claim itself is an await: if the meeting moved, this seat belongs to its old identity.
        if (identityMoved()) {
          refuseMovedMeeting();
          return;
        }
      }
      context.reservations.add({ participantName: name, seatId });
      context.session.addHolder({
        name,
        seat: seatId,
        ...(photoUrl === undefined ? {} : { photoUrl }),
        ...(email === undefined ? {} : { email }),
      });
      context.refreshRealPeople();
      context.runnerStateChanged();
      context.meetingStateChanged();
      if (hadPeople) context.rejoin.occupied();
      else context.rejoin.joined();
      context.scheduleSave();
      context.watchRoom(roomName);
      console.log(`[join] seat=${seatId} room=${roomName} real=true principal=${principal.kind} name=${name}`);
      sendJson(response, 200, {
        token,
        url: livekitPublicUrl(),
        participantRole: seatId,
        resumed: admissionPhase === 'running',
        started: admissionPhase === 'running',
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

/** Issues the LiveKit token for the one meeting this instance serves. */
export async function handleLivekitToken(call: RouteCall): Promise<void> {
  if (call.context.realMeeting) {
    await handleRealLivekitToken(call);
    return;
  }
  await handlePracticeLivekitToken(call);
}

/**
 * Join one visitor's own practice meeting. The meeting's capability cookie is the only authority:
 * it names this meeting and the seat its visitor took. Joining never resets the practice.
 */
async function handlePracticeLivekitToken(call: RouteCall): Promise<void> {
  const { request, response, context, principal } = call;
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
  if (join.kind !== 'practice') {
    sendJson(response, 409, { error: NO_TEAM_MEETING_MESSAGE });
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
  // The joiner's Google photo, when they have an account. Looked up before the admission queue
  // so no extra await can land between the seat claim and the holder it records.
  let joinerPhotoUrl: string | undefined;
  let joinerEmail: string | undefined;
  if (
    context.auth !== undefined &&
    (principal.kind === 'host' || principal.kind === 'user') &&
    principal.userId !== undefined
  ) {
    const user = await context.auth.store.findUserById(principal.userId);
    joinerPhotoUrl = user?.picture ?? undefined;
    joinerEmail = user?.email;
  }
  try {
    await context.admit(async () => {
      if (context.session.phase() === 'starting') {
        sendJson(response, 409, {
          error: 'The meeting is starting; try again in a moment.',
          retryable: true,
        });
        return;
      }
      // One visitor's practice is reached only with the capability its creation handed out.
      if (context.session.kind() !== 'practice' || context.practicePrincipal(request) === undefined) {
        sendJson(response, 403, { error: 'Practice access belongs to its practice meeting only.' });
        return;
      }
      const admissionPhase = context.session.phase();
      const admissionGeneration = context.session.generation();
      const admissionMeetingId = context.meeting.id;
      // A saved meeting that did not come back running is consumed: the visitor starts a fresh one.
      if (context.session.restoredWithoutMeeting()) {
        sendJson(response, 409, {
          error: 'practice-ended',
          message: 'This practice meeting has ended. Start a new practice.',
        });
        return;
      }
      if (admissionPhase === 'ended') {
        sendJson(response, 409, {
          error: 'practice-ended',
          message: 'This practice meeting has ended. Start a new practice.',
        });
        return;
      }
      const seat = humanAttendeeForRole(context.fullScenario, wantedRole);
      if (seat === undefined) {
        sendJson(response, 400, {
          error: notAHumanSeat(wantedRole, joinSeatRoles(context.fullScenario)),
        });
        return;
      }
      const seatId = seat.role;
      const practiceSeat = context.session.practiceSeat();
      if (
        practiceSeat !== undefined &&
        practiceSeat.trim().toLowerCase() !== seatId.trim().toLowerCase()
      ) {
        sendJson(response, 403, { error: 'Practice access belongs to the seat its visitor took.' });
        return;
      }
      const npcNames = (context.fullScenario.npcs ?? []).map((npc) => npc.attendee);
      const reservedNames = [...npcNames, KAKI_LISTENER_IDENTITY];
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
      // A reservation made by this same visitor is a retry, not another seat: let them reclaim it.
      const otherReservations = context.reservations
        .active(rosterHumans.map((person) => person.name))
        .filter(
          (reservation) =>
            reservation.participantName.toLowerCase() !== participantName.toLowerCase(),
        );
      const present = [
        ...rosterHumans,
        ...otherReservations.map((reservation) => ({
          name: reservation.participantName,
          role: reservation.seatId,
        })),
      ];
      const roomEmpty = present.length === 0;
      const requestedMax = Number(process.env.NPC_MAX_HUMANS);
      const envMax = Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : undefined;
      const problem = seatProblem(context.fullScenario, present, seatId, envMax);
      if (problem !== undefined) {
        sendJson(response, 409, { error: problem });
        return;
      }
      if (present.some((person) => person.name.toLowerCase() === participantName.toLowerCase())) {
        sendJson(response, 409, {
          error: `"${participantName}" is already in the meeting. Pick another name.`,
        });
        return;
      }
      // Refuse a bad display name before anything can change the meeting.
      if (isKakiListener(participantName)) {
        throw new JoinError(`"${participantName}" is reserved for the meeting listener; pick another name`);
      }
      const nameProblem = joinNameProblem(participantName, reservedNames);
      if (nameProblem !== undefined) throw new JoinError(nameProblem);

      // A Start or reset that landed while this join awaited the roster must not let it mutate a
      // meeting it never saw: refuse before the token and seat claim, and let the client retry.
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

      // The first person into the practice draws its topics for their seat, exactly as the shared
      // practice room did on its first join. A running practice is already shaped: doing it again
      // would be an illegal transition (and used to be a 500 on rejoin).
      if (admissionPhase === 'lobby') context.shapeLobbyFor(seatId);
      context.session.bindPracticeSeat(seatId);
      const roomName = context.roomNameFor(admissionMeetingId);
      const token = await createRoomToken(
        { roomName, participantName, participantRole: seatId },
        reservedNames,
      );
      // The token is an await: a lifecycle change that landed during it belongs to another meeting.
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
      context.reservations.add({ participantName, seatId });
      context.session.addHolder({
        name: participantName,
        seat: seatId,
        ...(joinerPhotoUrl === undefined ? {} : { photoUrl: joinerPhotoUrl }),
        ...(joinerEmail === undefined ? {} : { email: joinerEmail }),
      });
      context.runnerStateChanged();
      context.meetingStateChanged();
      if (roomEmpty) context.rejoin.joined();
      else context.rejoin.occupied();
      context.scheduleSave();
      context.watchRoom(roomName);
      // The sample workspace's demo profiles follow the visitor's display name.
      if (context.workspaceId === SAMPLE_WORKSPACE_ID) {
        void syncDemoVisitorProfile(participantName);
      }
      const resumed = admissionPhase === 'running';
      const started = context.session.phase() === 'running';
      console.log(`[join] seat=${seatId} room=${roomName} practice=true resumed=${resumed} started=${started}`);
      sendJson(response, 200, { token, url: livekitPublicUrl(), resumed, started });
    });
  } catch (error) {
    if (error instanceof JoinError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    throw error;
  }
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
  // A visitor's own practice never becomes a real meeting.
  if (context.perVisitorPractice) {
    sendJson(response, 409, { error: 'There is no team meeting room open to open here.' });
    return;
  }
  // The owner opens the team meeting: the current draft is its plan. Serialized with joins and
  // Start so an admission cannot slip in between the checks and the commit.
  const outcome = await context.admit(async () => {
    const phase = context.session.phase();
    if (phase === 'starting') {
      return { status: 409, body: { error: 'The meeting is starting; try again in a moment.', retryable: true } };
    }
    if (phase === 'running' && !context.session.abandoned()) {
      return {
        status: 409,
        body: { error: 'This meeting has already started. It cannot be opened again until it ends.' },
      };
    }
    // An ended or abandoned meeting is consumed by opening the next one.
    if (phase === 'ended' || (phase === 'running' && context.session.abandoned())) {
      context.session.reset();
    }
    // A reset clears the journey; opening the room makes it a real meeting again.
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
