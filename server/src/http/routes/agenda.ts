import { isObject, KOPITIAM_INVITE_UID, parseMeetingInvite } from '@kaki/shared';
import { CALENDAR_CONFIG_MESSAGE, CalendarFetchError, fetchCalendarIcs } from '../../action/calendar';
import {
  askTellKaki,
  TELL_KAKI_REPLY_MESSAGE,
  TELL_KAKI_UNAVAILABLE_MESSAGE,
  TellKakiReplyError,
} from '../../host/tellKaki';
import type { RouteCall } from '../routeCall';
import { readJsonBody, sendJson } from '../http';

const MAX_BODY_BYTES = 64_000;
const MAX_TEXT_LENGTH = 8_000;

export async function handleTellKaki(call: RouteCall): Promise<void> {
  const { request, response, context } = call;
  const parsed = await readJsonBody(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    sendJson(response, 400, { error: parsed.error });
    return;
  }
  if (!isObject(parsed.value)) {
    sendJson(response, 400, { error: 'Body must be a JSON object' });
    return;
  }
  const text = typeof parsed.value.text === 'string' ? parsed.value.text.trim() : '';
  if (text.length < 1 || text.length > MAX_TEXT_LENGTH) {
    sendJson(response, 400, { error: 'Tell Kaki what the meeting is about in 1-8000 characters.' });
    return;
  }

  const llm = context.llm;
  if (llm === undefined) {
    sendJson(response, 503, { error: TELL_KAKI_UNAVAILABLE_MESSAGE });
    return;
  }

  try {
    const reply = await askTellKaki(llm, text);
    sendJson(response, 200, reply);
  } catch (error) {
    if (error instanceof TellKakiReplyError) {
      sendJson(response, 502, { error: TELL_KAKI_REPLY_MESSAGE });
      return;
    }
    console.error('kaki tell-kaki: the model failed', error);
    sendJson(response, 503, { error: TELL_KAKI_UNAVAILABLE_MESSAGE });
  }
}

export async function handleAgendaFromCalendar(call: RouteCall): Promise<void> {
  const { response, context } = call;
  if (context.calendar === undefined) {
    sendJson(response, 503, { error: CALENDAR_CONFIG_MESSAGE });
    return;
  }

  let ics: string;
  try {
    ics = await fetchCalendarIcs(context.calendar, context.calendarFetch);
  } catch (error) {
    if (error instanceof CalendarFetchError) {
      sendJson(response, error.status, { error: error.message });
    } else {
      console.error('kaki agenda: calendar read failed', error);
      sendJson(response, 502, { error: 'The calendar could not be read.' });
    }
    return;
  }

  const parsedInvite = parseMeetingInvite(ics, { uid: KOPITIAM_INVITE_UID, ignoreOwners: true });
  if (!parsedInvite.ok) {
    const missing = parsedInvite.errors.some((problem) => problem.field === 'invite');
    sendJson(
      response,
      missing ? 404 : 422,
      missing
        ? { error: parsedInvite.errors[0]?.message ?? 'The calendar invite was not found.' }
        : { error: 'The calendar invite agenda could not be read.', errors: parsedInvite.errors },
    );
    return;
  }

  const invite = parsedInvite.value;
  sendJson(response, 200, {
    title: invite.title,
    agenda: invite.agenda.map((item) => ({ title: item.title, minutes: item.minutes })),
  });
}
