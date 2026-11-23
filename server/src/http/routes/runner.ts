import { isKakiEvent, isMeetingMemoryEntries, isSuggestInput, type Task } from '@kaki/shared';
import { CommandError } from '../../core/hub';
import { MAX_BODY_BYTES, type RouteCall } from '../routeCall';
import { readJsonBody, sendJson } from '../http';

/** Events that carry the room's content; off the record none of them may be published or stored. */
const CONTENT_EVENT_TYPES = new Set([
  'TRANSCRIPT_CHUNK',
  'TRANSCRIPT_LINE_UPDATED',
  'MEETING_RECORD_UPDATED',
  'HOST_SPEECH_TRIGGERED',
  'TASK_UPDATED',
  'TOPIC_SETTLED',
  'COLLEAGUE_REACTION',
]);

/** True while a real meeting is off the record: nothing from the room is kept. */
function offTheRecord(context: RouteCall['context']): boolean {
  return context.meetingKind() === 'real' && context.isOffTheRecord?.() === true;
}

/** Accepts one demo event onto the hub, keeping transcript and reactions live-only and retaining the rest. */
export async function handleEmit(call: RouteCall): Promise<void> {
  const { request, response, context } = call;
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    sendJson(response, body.status, { error: body.error });
    return;
  }
  if (!isKakiEvent(body.value, context.session.active())) {
    sendJson(response, 400, { error: 'Body must be a valid KakiEvent' });
    return;
  }
  if (body.value.type === 'MEETING_RESET') {
    sendJson(response, 400, { error: 'MEETING_RESET can only be published by the meeting session' });
    return;
  }
  if (offTheRecord(context) && CONTENT_EVENT_TYPES.has(body.value.type)) {
    // Off the record: the runner may keep speaking, but none of the room's content is published,
    // analysed by Wingman or the notetaker, or saved.
    sendJson(response, 200, { ok: true, ignored: true });
    return;
  }

  // Transcript lines, their display updates and reactions are live-only: replaying them to a page that opens
  // later shows ghost speech or a stale reaction badge. Everything else a demo emits (nudges, facts, tasks)
  // stays available to phones that join later.
  const liveOnly =
    body.value.type === 'TRANSCRIPT_CHUNK' ||
    body.value.type === 'TRANSCRIPT_LINE_UPDATED' ||
    body.value.type === 'COLLEAGUE_REACTION';
  context.hub.publish(
    body.value,
    liveOnly ? undefined : { retainKey: `dev:${JSON.stringify(body.value)}` },
  );
  sendJson(response, 200, { ok: true });
  return;
}

/** Accepts the runner's transcribed or typed human line and writes it through the server's one transcript writer. */
export async function handleHumanLine(call: RouteCall): Promise<void> {
  const { request, response, context } = call;
  // The default server-side recogniser hears the person on the runner's echo-cancelled track.
  // The runner forwards the accepted words here so the app server still owns the transcript write.
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    sendJson(response, body.status, { error: body.error });
    return;
  }
  const value = body.value as {
    seat?: unknown;
    text?: unknown;
    source?: unknown;
    clientLineId?: unknown;
    meetingId?: unknown;
    participantIdentity?: unknown;
    speechStartedAt?: unknown;
    speechEndedAt?: unknown;
    micLevel?: unknown;
    overlap?: unknown;
  };
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof value.seat !== 'string' ||
    value.seat.trim() === '' ||
    typeof value.text !== 'string' ||
    value.text.trim() === '' ||
    (value.source !== 'speech' && value.source !== 'typed') ||
    typeof value.clientLineId !== 'string' ||
    value.clientLineId.trim() === '' ||
    typeof value.meetingId !== 'string' ||
    value.meetingId.trim() === '' ||
    typeof value.participantIdentity !== 'string' ||
    value.participantIdentity.trim() === '' ||
    (value.speechStartedAt !== undefined &&
      (typeof value.speechStartedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.speechStartedAt)))) ||
    (value.speechEndedAt !== undefined &&
      (typeof value.speechEndedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.speechEndedAt)))) ||
    (value.micLevel !== undefined &&
      (typeof value.micLevel !== 'number' ||
        !Number.isFinite(value.micLevel) ||
        value.micLevel < 0 ||
        value.micLevel > 1)) ||
    (value.overlap !== undefined && typeof value.overlap !== 'boolean')
  ) {
    sendJson(response, 400, {
      error:
        'Body must be a human line with a meetingId, participantIdentity, seat, text, source and clientLineId',
    });
    return;
  }
  if (offTheRecord(context)) {
    sendJson(response, 200, { ok: true, ignored: true });
    return;
  }
  // The runner sends this on the person's behalf, so it is a real action even though the request
  // itself is runner traffic.
  context.idle.recordAction();
  try {
    context.writeHumanLine({
      seat: value.seat,
      text: value.text,
      source: value.source,
      clientLineId: value.clientLineId,
      meetingId: value.meetingId,
      participantIdentity: value.participantIdentity,
      ...(value.speechStartedAt === undefined ? {} : { speechStartedAt: value.speechStartedAt }),
      ...(value.speechEndedAt === undefined ? {} : { speechEndedAt: value.speechEndedAt }),
      ...(value.micLevel === undefined ? {} : { micLevel: value.micLevel }),
      ...(value.overlap === undefined ? {} : { overlap: value.overlap }),
    });
  } catch (error) {
    if (error instanceof CommandError) {
      sendJson(response, 409, { error: error.message });
      return;
    }
    throw error;
  }
  sendJson(response, 200, { ok: true });
  return;
}

/** Accepts a task suggestion from the runner and returns the card the task store created. */
export async function handleSuggestTask(call: RouteCall): Promise<void> {
  const { request, response, context } = call;
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    sendJson(response, body.status, { error: body.error });
    return;
  }
  if (!isSuggestInput(body.value, context.session.active())) {
    sendJson(response, 400, { error: 'Body must be a valid task suggestion' });
    return;
  }
  if (offTheRecord(context)) {
    sendJson(response, 200, { ok: true, ignored: true });
    return;
  }
  sendJson(response, 200, context.tasks.suggest(body.value));
  return;
}

/** Replaces the meeting memory with a validated runner-supplied fact list. */
export async function handleMeetingMemory(call: RouteCall): Promise<void> {
  const { request, response, context } = call;
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) { sendJson(response, body.status, { error: body.error }); return; }
  if (!isMeetingMemoryEntries(body.value, context.session.active().agenda.map((item) => item.title))) {
    sendJson(response, 400, { error: 'Invalid meeting memory' }); return;
  }
  if (offTheRecord(context)) { sendJson(response, 200, { ok: true, ignored: true }); return; }
  context.memory.splice(0, context.memory.length, ...body.value);
  sendJson(response, 200, { ok: true });
  return;
}

/** Creates the follow-up for a locked decision and releases the topic in one request. */
export async function handleSettleTopic(call: RouteCall): Promise<void> {
  const { request, response, context } = call;
  // The live demo's engine locked the visitor's decision on an agenda item: create its follow-up and release
  // whatever was held for that item, in one request so the two can never disagree.
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) {
    sendJson(response, body.status, { error: body.error });
    return;
  }
  if (!isSuggestInput(body.value, context.session.active())) {
    sendJson(response, 400, { error: 'Body must be a valid task suggestion with an agendaItemTitle' });
    return;
  }
  if (offTheRecord(context)) {
    sendJson(response, 200, { ok: true, ignored: true });
    return;
  }
  const followUp = body.value;
  const sourceSeconds = context.meetingElapsedSeconds?.();
  const reopening = new URL(request.url ?? '/', 'http://localhost').searchParams.get('reopen') === '1';
  const agendaTitle = followUp.agendaItemTitle;
  if (agendaTitle === undefined) {
    sendJson(response, 400, { error: 'Body must be a valid task suggestion with an agendaItemTitle' });
    return;
  }
  // The settlement is the visitor's authoritative follow-up for this topic, so it replaces whichever early
  // suggestion was being held for the same agenda item, role and deliverable, however differently the two were
  // worded. The sender names the exact held card it means; the server revises that card by id and never guesses
  // one from matching keys, because two cards can share the topic, role and kind.
  const sameTopic = (task: Task): boolean =>
    task.agendaItemTitle === followUp.agendaItemTitle &&
    task.suggestedAssignee === followUp.suggestedAssignee && (reopening || task.actionKind === followUp.actionKind);
  const matching = context.tasks.list().filter((task) => sameTopic(task) && task.status !== 'SUPERSEDED');
  const settled = matching.find((task) => task.status !== 'SUGGESTED' && task.status !== 'DISMISSED');
  const suggested = matching.filter((task) => task.status === 'SUGGESTED');
  const idSpecified = followUp.cardId !== undefined;
  const requested = followUp.cardId === undefined ? undefined : context.tasks.get(followUp.cardId);
  if (idSpecified && requested === undefined) {
    console.warn(
      `kaki server: settlement for "${agendaTitle}" named unknown card ${followUp.cardId}; revising nothing`,
    );
  } else if (requested !== undefined && !sameTopic(requested)) {
    console.warn(
      `kaki server: settlement for "${agendaTitle}" named card ${requested.id}, which belongs to another topic or owner; revising nothing`,
    );
  }
  let target = requested !== undefined && sameTopic(requested) ? requested : undefined;
  if (!idSpecified) {
    // The runner may not have seen the live TASK_UPDATED (a reconnect gap, or the card landing at
    // "Next up"). One held card matching this topic, owner and kind is unambiguous, so resolve it
    // here rather than create a second copy. More than one is genuinely ambiguous: revise none.
    if (suggested.length === 1) {
      target = suggested[0];
      console.info(
        `kaki server: settlement for "${agendaTitle}" named no card; resolved its one held card ${target?.id} server-side`,
      );
    } else if (suggested.length > 1) {
      console.warn(
        `kaki server: settlement for "${agendaTitle}" named no card; ${suggested.length} held cards match this topic, owner and kind, so none is revised`,
      );
    }
  }
  const targetAccepted = target !== undefined && target.status !== 'SUGGESTED' && target.status !== 'DISMISSED';
  const targetSameDecision = target !== undefined &&
    target.decisionSource === followUp.decisionSource && target.actionKind === followUp.actionKind;
  const settledSameDecision = settled !== undefined &&
    settled.decisionSource === followUp.decisionSource && settled.actionKind === followUp.actionKind;
  if (target !== undefined && targetAccepted && reopening && !targetSameDecision) {
    context.tasks.supersede(target.id);
  } else if (target === undefined && settled !== undefined && reopening && !settledSameDecision) {
    context.tasks.supersede(settled.id);
  }
  let task: Task;
  if (target !== undefined) {
    if (target.status === 'SUGGESTED') {
      task = context.tasks.reviseSuggested(target.id, followUp, sourceSeconds);
    } else if (targetAccepted && (!reopening || targetSameDecision)) {
      task = target;
    } else {
      // The named card was dismissed, superseded, or just superseded by this reopened decision.
      task = context.tasks.suggest(followUp, undefined, sourceSeconds);
    }
  } else if (!idSpecified && settled !== undefined && (!reopening || settledSameDecision)) {
    task = settled;
  } else {
    task = context.tasks.suggest(followUp, undefined, sourceSeconds);
  }
  // Only touch other held cards when the intended card is known. A missing, unknown or foreign id
  // must leave every card exactly as it was, rather than guess which one the settlement meant.
  if (target !== undefined) {
    for (const duplicate of suggested) {
      if (duplicate.id !== task.id) context.tasks.transition(duplicate.id, 'DISMISSED');
    }
  }
  context.hub.publish({
    type: 'TOPIC_SETTLED',
    audience: { kind: 'screen' },
    payload: { title: agendaTitle, taskId: task.id },
  });
  sendJson(response, 200, context.tasks.get(task.id));
  return;
}
