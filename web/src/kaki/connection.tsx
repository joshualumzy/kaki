import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  isKakiEvent,
  MEETING_ENDED_MESSAGE,
  type KakiCommand,
  type KakiEvent,
  type Role,
} from '@kaki/shared';
import { fetchMe } from '../auth/api';
import { useMeetingScope } from './meetingScope';
import { useScenario } from './ScenarioContext';

/** Which feed a consumer follows: a role's own seat, or one of the shared projections. */
export type KakiAudience =
  | { kind: 'role'; role: Role }
  | { kind: 'screen' }
  | { kind: 'lifecycle' }
  | { kind: 'participant' };

/** The shared wire a page's consumers talk through. One page owns one of these. */
export interface KakiLink {
  /** Listen to every valid event on the connection; returns an unsubscribe function. */
  subscribe(listener: (event: KakiEvent) => void): () => void;
  /** Run a callback after each (re)connect, with the generation that socket belongs to. */
  onOpen(listener: (generation: number) => void): () => void;
  /** Send a command as one of this link's audiences; false when it is not open or not subscribed. */
  send(command: KakiCommand, audience: KakiAudience): boolean;
  /** True when this socket generation is still the open one, so a late answer belongs to the present. */
  isCurrent(generation: number): boolean;
}

/** The connection state pages read alongside the link. */
export interface KakiConnectionValue {
  link: KakiLink;
  connected: boolean;
  ended: string | undefined;
  /** The seat this page holds, so a shared screen also sees only its own private seat notes. */
  seat: string;
}

interface KakiLinkResult {
  /** The stable link object; the state around it changes as the socket opens and closes. */
  link: KakiLink;
  connected: boolean;
  ended: string | undefined;
}

/** How one audience is written on the wire, both in the page query and a command envelope. */
function audienceToken(audience: KakiAudience): string {
  return audience.kind === 'role' ? `role:${encodeURIComponent(audience.role)}` : audience.kind;
}

/** The same value in the shape a command envelope carries. */
function audienceValue(audience: KakiAudience): KakiAudience {
  return audience.kind === 'role' ? { kind: 'role', role: audience.role } : { kind: audience.kind };
}

function sameAudience(left: KakiAudience, right: KakiAudience): boolean {
  if (left.kind === 'role' || right.kind === 'role') {
    return left.kind === 'role' && right.kind === 'role' && left.role === right.role;
  }
  return left.kind === right.kind;
}

/** True when an event belongs in a consumer's feed, even when one socket carries several feeds. */
export function wantsAudienceEvent(
  event: KakiEvent,
  audience: KakiAudience,
  seat?: string,
): boolean {
  if (audience.kind === 'lifecycle') {
    return event.type === 'MEETING_STARTED' || event.type === 'MEETING_RESET' || event.type === 'MEETING_RESTORED';
  }
  if (audience.kind === 'role') {
    return (
      event.audience.kind === 'all' ||
      (event.audience.kind === 'role' && event.audience.role === audience.role)
    );
  }
  // A screen or participant socket is already the projection that feed needs. When it shares a
  // socket with a role, it may also see that seat's private notes, but no other seat's.
  if (event.audience.kind === 'role') {
    return seat === undefined || event.audience.role === seat;
  }
  return event.audience.kind === 'all' || event.audience.kind === 'screen';
}

/**
 * One Kaki WebSocket, shared by every consumer on a page. A single audience keeps the older URL;
 * a page's set travels as `?audiences=` so the server can route several feeds over one connection.
 * Reconnect, backoff, the ended-meeting close and the failed-reconnect session check live here once.
 */
export function useKakiLink(audiences: readonly KakiAudience[] | undefined): KakiLinkResult {
  const scenario = useScenario();
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;
  const { meetingId } = useMeetingScope();
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState<string | undefined>(undefined);
  const eventListeners = useRef(new Set<(event: KakiEvent) => void>());
  const openListeners = useRef(new Set<(generation: number) => void>());
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const openSocketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const attempts = useRef(0);
  const generation = useRef(0);
  const audiencesRef = useRef(audiences);
  audiencesRef.current = audiences;
  /** A stable identity for the set, so a new array with the same feeds never reconnects. */
  const wire = audiences === undefined ? undefined : JSON.stringify(audiences);

  const subscribe = useCallback((listener: (event: KakiEvent) => void): (() => void) => {
    eventListeners.current.add(listener);
    return () => {
      eventListeners.current.delete(listener);
    };
  }, []);

  const onOpen = useCallback((listener: (generation: number) => void): (() => void) => {
    openListeners.current.add(listener);
    return () => {
      openListeners.current.delete(listener);
    };
  }, []);

  const isCurrent = useCallback(
    (asked: number): boolean =>
      openSocketRef.current?.readyState === WebSocket.OPEN && generation.current === asked,
    [],
  );

  const send = useCallback((command: KakiCommand, audience: KakiAudience): boolean => {
    const socket = socketRef.current;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
    const active = audiencesRef.current;
    if (active === undefined) return false;
    let payload: unknown = command;
    if (active.length > 1) {
      if (!active.some((candidate) => sameAudience(candidate, audience))) return false;
      payload = { type: 'MULTIPLEX_COMMAND', audience: audienceValue(audience), command };
    }
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  const link = useMemo<KakiLink>(
    () => ({ subscribe, onOpen, send, isCurrent }),
    [subscribe, onOpen, send, isCurrent],
  );

  useEffect(() => {
    if (wire === undefined) return;
    setConnected(false);
    setEnded(undefined);
    attempts.current = 0;
    let closed = false;
    let endedForGood = false;
    let socket: WebSocket | undefined;

    function query(): string {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const meetingQuery =
        meetingId === undefined || meetingId === ''
          ? ''
          : `&meeting=${encodeURIComponent(meetingId)}`;
      const list = audiencesRef.current;
      if (list === undefined || list.length === 0) return '';
      if (list.length === 1) {
        const audience = list[0]!;
        // Roles and shared feeds travel on separate channels: a role id may be any word, including
        // `participant`, so it can never be mistaken for the projection by its spelling.
        const channel =
          audience.kind === 'role'
            ? `role=${encodeURIComponent(audience.role)}`
            : `audience=${encodeURIComponent(audience.kind)}`;
        return `${protocol}//${window.location.host}/ws?${channel}${meetingQuery}`;
      }
      const params = new URLSearchParams();
      for (const audience of list) params.append('audiences', audienceToken(audience));
      return `${protocol}//${window.location.host}/ws?${params.toString()}${meetingQuery}`;
    }

    function connect(): void {
      if (closed || endedForGood) return;
      let opened = false;
      const url = query();
      if (url === '') return;
      const current = new WebSocket(url);
      socket = current;
      socketRef.current = current;

      current.addEventListener('open', () => {
        if (closed) return;
        opened = true;
        attempts.current = 0;
        openSocketRef.current = current;
        generation.current += 1;
        setConnected(true);
        setEnded(undefined);
        for (const listener of [...openListeners.current]) {
          try {
            listener(generation.current);
          } catch (error) {
            console.error('kaki web: a connection listener failed', error);
          }
        }
      });

      current.addEventListener('message', (message) => {
        if (typeof message.data !== 'string') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data) as unknown;
        } catch {
          console.warn('kaki web: ignored a non-JSON message');
          return;
        }
        if (!isKakiEvent(parsed, scenarioRef.current)) {
          console.warn('kaki web: ignored an invalid event', parsed);
          return;
        }
        const event = Object.assign(parsed, { receivedAt: Date.now() });
        for (const listener of [...eventListeners.current]) {
          try {
            listener(event);
          } catch (error) {
            console.error('kaki web: an event listener failed', error);
          }
        }
      });

      current.addEventListener('close', (event) => {
        if (closed || endedForGood) return;
        if (openSocketRef.current === current) openSocketRef.current = undefined;
        setConnected(false);
        const closeEvent = event as CloseEvent | undefined;
        if (closeEvent?.code === 4001) {
          endedForGood = true;
          if (reconnectTimer.current !== undefined) {
            window.clearTimeout(reconnectTimer.current);
            reconnectTimer.current = undefined;
          }
          setEnded(closeEvent.reason === '' ? MEETING_ENDED_MESSAGE : closeEvent.reason);
          return;
        }
        if (!opened) {
          // A reconnect was refused before it opened. Ask whether this phone's meeting is gone;
          // otherwise the backoff below keeps retrying at a bounded pace.
          void fetchMe()
            .then((me) => {
              if (closed || endedForGood) return;
              if (me.authEnabled && me.kind === null && me.ended === true) {
                endedForGood = true;
                if (reconnectTimer.current !== undefined) {
                  window.clearTimeout(reconnectTimer.current);
                  reconnectTimer.current = undefined;
                }
                socket?.close();
                setEnded(MEETING_ENDED_MESSAGE);
              }
            })
            .catch((error: unknown) => {
              console.warn('kaki web: could not re-check the session after a failed reconnect', error);
            });
        }
        if (endedForGood) return;
        const delay = Math.min(5000, 500 * 2 ** attempts.current);
        attempts.current += 1;
        reconnectTimer.current = window.setTimeout(connect, delay);
      });

      current.addEventListener('error', () => current.close());
    }

    connect();

    return () => {
      closed = true;
      if (reconnectTimer.current !== undefined) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = undefined;
      }
      socket?.close();
      if (socketRef.current === socket) socketRef.current = undefined;
      if (openSocketRef.current === socket) openSocketRef.current = undefined;
    };
  }, [wire, meetingId]);

  return { link, connected, ended };
}

const KakiConnectionContext = createContext<KakiConnectionValue | null>(null);

/**
 * Put one Kaki socket around a meeting page. Every `useKaki` beneath it subscribes to this link
 * instead of opening a socket of its own; the link follows the page's shared feed and its seat.
 */
export function KakiConnectionProvider({
  role,
  sharedAudience,
  children,
}: {
  role: string;
  sharedAudience: 'screen' | 'participant';
  children: ReactNode;
}) {
  const audiences = useMemo<KakiAudience[]>(
    () => [
      sharedAudience === 'screen' ? { kind: 'screen' } : { kind: 'participant' },
      { kind: 'role', role },
    ],
    [sharedAudience, role],
  );
  const { link, connected, ended } = useKakiLink(audiences);
  const value = useMemo<KakiConnectionValue>(
    () => ({ link, connected, ended, seat: role }),
    [link, connected, ended, role],
  );
  return <KakiConnectionContext.Provider value={value}>{children}</KakiConnectionContext.Provider>;
}

/** The page's one Kaki connection, or null outside a meeting page that provides one. */
export function useKakiConnection(): KakiConnectionValue | null {
  return useContext(KakiConnectionContext);
}
