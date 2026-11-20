import { useEffect, useState } from 'react';
import { toString as qrCodeSvg } from 'qrcode';
import { humanSeatRoles } from '@kaki/shared';
import { useScenario } from '../kaki';
import { fetchWithTimeout } from '../net/withTimeout';
import { Button, Card } from '../ui';
import './join-phones.css';

type JoinState =
  | { kind: 'loading' }
  | { kind: 'ready'; baseUrl: string; code: string }
  | { kind: 'error'; message: string };

function phoneUrl(baseUrl: string, roleId: string, code: string): string {
  const query = `role=${encodeURIComponent(roleId)}`;
  return `${baseUrl}/phone?${query}&code=${encodeURIComponent(code)}`;
}

/** Shared-screen card with one QR code per human seat so phones can join. */
export function JoinPhones({ meetingId }: { meetingId: string | undefined }) {
  const scenario = useScenario();
  const [state, setState] = useState<JoinState>({ kind: 'loading' });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function load(): Promise<void> {
      try {
        const [response, codeResponse] = await Promise.all([
          fetchWithTimeout('/api/join-info', { signal: controller.signal }),
          fetchWithTimeout('/api/meeting-code', { signal: controller.signal }),
        ]);
        const body = (await response.json().catch(() => null)) as
          | { baseUrl?: unknown; error?: unknown }
          | null;

        if (controller.signal.aborted) return;

        if (!response.ok) {
          const message =
            typeof body?.error === 'string' ? body.error : `Server returned ${response.status}`;
          setState({ kind: 'error', message });
          return;
        }

        if (typeof body?.baseUrl !== 'string' || body.baseUrl === '') {
          setState({ kind: 'error', message: 'The server returned no join address.' });
          return;
        }

        const codeBody = (await codeResponse.json().catch(() => null)) as
          | { code?: unknown; error?: unknown }
          | null;
        if (!codeResponse.ok) {
          const message =
            typeof codeBody?.error === 'string'
              ? codeBody.error
              : `Server returned ${codeResponse.status} for the meeting code`;
          setState({ kind: 'error', message });
          return;
        }
        if (typeof codeBody?.code !== 'string' || codeBody.code.trim() === '') {
          setState({ kind: 'error', message: 'The server returned no meeting code.' });
          return;
        }

        setState({ kind: 'ready', baseUrl: body.baseUrl, code: codeBody.code.trim() });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not reach the server.',
        });
      }
    }

    void load();
    return () => controller.abort();
  }, [meetingId, retryCount]);

  if (state.kind === 'error') {
    return (
      <Card title="Join on your phone">
        <p className="task-error" role="alert">
          Could not create the phone join links: {state.message}
        </p>
        <p className="join-hint">
          Set <code>KAKI_PUBLIC_URL</code> on the server if phones cannot reach this machine.
        </p>
        <Button
          onClick={() => {
            setState({ kind: 'loading' });
            setRetryCount((count) => count + 1);
          }}
        >
          Try again
        </Button>
      </Card>
    );
  }

  return (
    <Card title="Join on your phone">
      {state.kind === 'loading' ? (
        <p className="empty-state">Finding this screen&apos;s address…</p>
      ) : (
        <>
          <p className="join-code">
            Meeting code: <strong>{state.code}</strong>
          </p>
          <ul className="join-phones">
            {humanSeatRoles(scenario).map((role) => {
              const url = phoneUrl(state.baseUrl, role.id, state.code);
              return (
                <li className="join-phone" key={role.id}>
                  <RoleQrCode value={url} label={role.label} />
                  <p className="join-role">{role.label}</p>
                  <p className="join-url">{url}</p>
                </li>
              );
            })}
          </ul>
          <p className="join-hint">
            Phones must be on the same Wi-Fi. Base URL: <code>{state.baseUrl}</code>
          </p>
        </>
      )}
    </Card>
  );
}

function RoleQrCode({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);

    qrCodeSvg(value, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' })
      .then((svg) => {
        if (!cancelled) {
          setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) {
    return (
      <p className="task-error" role="alert">
        QR code for {label} could not be drawn.
      </p>
    );
  }

  if (src === null) {
    return <div className="join-qr join-qr-pending" aria-hidden="true" />;
  }

  return (
    <img
      className="join-qr"
      src={src}
      alt={`QR code to join as ${label}`}
      width={220}
      height={220}
    />
  );
}
