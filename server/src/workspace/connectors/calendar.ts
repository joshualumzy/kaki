import { isObject } from '@kaki/shared';
import { credentialsInUrlMessage, urlHasCredentials } from '../../action/basicAuth';
import { probeCalendar, type CalendarSettings } from '../../action/calendar';
import { ConnectorError, type ToolConnector } from '../connector';

function typed(settings: Record<string, unknown>, password = ''): CalendarSettings {
  const caldavUrl = settings.caldavUrl;
  if (typeof caldavUrl !== 'string' || caldavUrl.trim() === '') {
    throw new ConnectorError('The calendar needs its CalDAV URL.');
  }
  if (urlHasCredentials(caldavUrl)) {
    throw new ConnectorError(credentialsInUrlMessage('calendar'));
  }
  const user = typeof settings.user === 'string' ? settings.user.trim() : '';
  const secret = password.trim();
  if (secret !== '' && user === '') {
    throw new ConnectorError('Enter the calendar username for its password.');
  }
  const viewBaseUrl =
    typeof settings.viewBaseUrl === 'string' && settings.viewBaseUrl.trim() !== ''
      ? settings.viewBaseUrl.trim()
      : `http://127.0.0.1:${process.env.PORT ?? '3001'}`;
  return {
    caldavUrl: caldavUrl.trim(),
    viewBaseUrl,
    ...(user === '' ? {} : { user }),
    ...(secret === '' ? {} : { password: secret }),
    ...(typeof settings.calendar === 'string' && settings.calendar.trim() !== ''
      ? { calendar: settings.calendar.trim() }
      : {}),
  };
}

/** A CalDAV calendar; its password is the saved secret, never part of its URL. */
export const calendarConnector: ToolConnector = {
  kind: 'calendar',
  normalizeSettings(value) {
    if (!isObject(value)) return { ok: false, error: 'Settings must be a JSON object.' };
    try {
      const settings = typed(value);
      return {
        ok: true,
        settings: {
          caldavUrl: settings.caldavUrl,
          viewBaseUrl: settings.viewBaseUrl,
          ...(settings.user === undefined ? {} : { user: settings.user }),
          ...(settings.calendar === undefined ? {} : { calendar: settings.calendar }),
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Calendar settings are incomplete.' };
    }
  },
  test(settings, token) {
    return probeCalendar(typed(settings, token));
  },
  async listTargets() {
    return [];
  },
  targetRef() {
    return undefined;
  },
};
