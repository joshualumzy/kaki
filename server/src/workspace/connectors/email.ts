import { isObject } from '@kaki/shared';
import { probeEmail, type EmailSettings } from '../../action/email';
import { ConnectorError, type ToolConnector } from '../connector';

function typed(settings: Record<string, unknown>): EmailSettings {
  const smtpHost = settings.smtpHost;
  const from = settings.from;
  const mailpitUrl = settings.mailpitUrl;
  const smtpPort = Number(settings.smtpPort);
  if (typeof smtpHost !== 'string' || smtpHost.trim() === '') throw new ConnectorError('Email needs its SMTP host.');
  if (typeof from !== 'string' || from.trim() === '') throw new ConnectorError('Email needs its from address.');
  if (typeof mailpitUrl !== 'string' || mailpitUrl.trim() === '') throw new ConnectorError('Email needs its mailbox URL.');
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new ConnectorError('Email needs a valid SMTP port.');
  }
  return { smtpHost: smtpHost.trim(), smtpPort, from: from.trim(), mailpitUrl: mailpitUrl.trim() };
}

/** Email: a mailbox and its sending side; it takes no token of its own. */
export const emailConnector: ToolConnector = {
  kind: 'email',
  normalizeSettings(value) {
    if (!isObject(value)) return { ok: false, error: 'Settings must be a JSON object.' };
    try {
      const settings = typed(value);
      return {
        ok: true,
        settings: {
          smtpHost: settings.smtpHost,
          smtpPort: settings.smtpPort,
          from: settings.from,
          mailpitUrl: settings.mailpitUrl,
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Email settings are incomplete.' };
    }
  },
  test(settings) {
    return probeEmail(typed(settings));
  },
  async listTargets() {
    return [];
  },
  targetRef() {
    return undefined;
  },
};
