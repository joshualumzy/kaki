import { describe, expect, it, vi } from 'vitest';
import {
  probeEmail,
  type EmailSettings,
  type EmailTransport,
  type EmailTransportFactory,
} from '../../src/action/email';

const settings: EmailSettings = {
  smtpHost: '127.0.0.1',
  smtpPort: 1025,
  from: 'kaki@nanyangkopitiam.example',
  mailpitUrl: 'http://mailpit.test',
};

function mailboxFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => Response.json({ messages: [], total: 0 }));
}

function fakeTransport(verify: () => Promise<true>): {
  factory: EmailTransportFactory;
  sendMail: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sendMail = vi.fn(async () => ({}));
  const close = vi.fn();
  const transport: EmailTransport & { sendMail: typeof sendMail } = { verify, close, sendMail };
  return { factory: () => transport, sendMail, close };
}

function smtpError(message: string, props: Record<string, unknown>): Error {
  return Object.assign(new Error(message), props);
}

describe('email probe', () => {
  it('succeeds when both the mailbox and the sending side answer', async () => {
    const fetchImpl = mailboxFetch();
    const { factory, sendMail, close } = fakeTransport(async () => true);

    const result = await probeEmail(settings, { fetchImpl, createTransport: factory });

    expect(result).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sendMail).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('names the sending side when SMTP refuses the connection', async () => {
    const { factory, sendMail } = fakeTransport(async () => {
      throw smtpError('connect ECONNREFUSED 127.0.0.1:1025', { code: 'ECONNREFUSED' });
    });

    const result = await probeEmail(settings, { fetchImpl: mailboxFetch(), createTransport: factory });

    expect(result).toMatchObject({ ok: false, problem: 'unreachable' });
    if (result.ok) throw new Error('expected a failure');
    expect(result.message).toMatch(/sending side/i);
    expect(result.message).toMatch(/could not be reached|not answering/i);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('reports a timeout when SMTP verify hangs', async () => {
    const { factory, sendMail } = fakeTransport(() => new Promise<true>(() => {}));

    const result = await probeEmail(settings, {
      fetchImpl: mailboxFetch(),
      createTransport: factory,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ ok: false, problem: 'timeout' });
    if (result.ok) throw new Error('expected a failure');
    expect(result.message).toMatch(/sending side/i);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('reports an auth failure when SMTP rejects the credentials', async () => {
    const { factory, sendMail } = fakeTransport(async () => {
      throw smtpError('Invalid login: 535 Authentication failed', { code: 'EAUTH', responseCode: 535 });
    });

    const result = await probeEmail(settings, { fetchImpl: mailboxFetch(), createTransport: factory });

    expect(result).toMatchObject({ ok: false, problem: 'auth failed' });
    if (result.ok) throw new Error('expected a failure');
    expect(result.message).toMatch(/credentials|auth/i);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('still reports a mailbox failure when the inbox cannot be read', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:1');
    });
    const { factory, sendMail } = fakeTransport(async () => true);

    const result = await probeEmail(settings, { fetchImpl, createTransport: factory });

    expect(result).toMatchObject({ ok: false, problem: 'unreachable' });
    if (result.ok) throw new Error('expected a failure');
    expect(result.message).toMatch(/mail server/i);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
