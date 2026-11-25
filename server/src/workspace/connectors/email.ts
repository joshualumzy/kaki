import { isObject } from '@kaki/shared';
import { credentialsInUrlMessage, urlHasCredentials } from '../../action/basicAuth';
import { probeEmail, type EmailSettings } from '../../action/email';
import { ConnectorError, type ToolConnector } from '../connector';

function typed(settings: Record<string, unknown>, password = ''): EmailSettings {
  const smtpHost = settings.smtpHost;
  const from = settings.from;
  const mailpitUrl = settings.mailpitUrl;
  const smtpPort = Number(settings.smtpPort);
  if (typeof smtpHost !== 'string' || smtpHost.trim() === '') throw new ConnectorError('Email needs its SMTP host.');
  if (smtpHost.includes('@') || smtpHost.includes('://')) {
    throw new ConnectorError('Enter the SMTP host on its own, and put the username and password in their fields.');
  }
  if (typeof from !== 'string' || from.trim() === '') throw new ConnectorError('Email needs its from address.');
  if (typeof mailpitUrl !== 'string' || mailpitUrl.trim() === '') throw new ConnectorError('Email needs its mailbox URL.');
  if (urlHasCredentials(mailpitUrl)) {
    throw new ConnectorError(credentialsInUrlMessage('mail'));
  }
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new ConnectorError('Email needs a valid SMTP port.');
  }
  const user = typeof settings.user === 'string' ? settings.user.trim() : '';
  const secret = password.trim();
  if (secret !== '' && user === '') {
    throw new ConnectorError('Enter the mail username for its password.');
  }
  return {
    smtpHost: smtpHost.trim(),
    smtpPort,
    from: from.trim(),
    mailpitUrl: mailpitUrl.trim(),
    ...(user === '' ? {} : { user }),
    ...(secret === '' ? {} : { password: secret }),
  };
}

/** Email: a mailbox and its sending side; its password is the saved secret, never part of a URL. */
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
          ...(settings.user === undefined ? {} : { user: settings.user }),
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Email settings are incomplete.' };
    }
  },
  test(settings, token) {
    return probeEmail(typed(settings, token));
  },
  async listTargets() {
    return [];
  },
  targetRef() {
    return undefined;
  },
};
