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

/** The shared wire a page's consumers talk through. Each link carries exactly one feed. */
export interface KakiLink {
  /** Listen to every valid event on the connection; returns an unsubscribe function. */
  subscribe(listener: (event: KakiEvent) => void): () => void;
  /** Run a callback after each (re)connect, with the generation that socket belongs to. */
  onOpen(listener: (generation: number) => void): () => void;
  /** Send a command on this feed's socket; false when it is not open. */
  send(command: KakiCommand): boolean;
  /** True when this socket generation is still the open one, so a late answer belongs to the present. */
  isCurrent(generation: number): boolean;
}

/** One feed's live connection, as a consumer of that feed sees it. */
export interface KakiFeed {
  link: KakiLink;
  connected: boolean;
  ended: string | undefined;
}

/** The connection state pages read alongside the links. */
export interface KakiConnectionValue {
  /** One link per distinct feed this page follows, keyed by `audienceKey`. */
  feeds: ReadonlyMap<string, KakiFeed>;
  /** The seat this page holds, so a shared screen also sees only its own private seat notes. */
  seat: string;
}

interface KakiLinkResult {
  /** The stable link object; the state around it changes as the socket opens and closes. */
  link: KakiLink;
  connected: boolean;
  ended: string | undefined;
}

interface FeedState {
  connected: boolean;
  ended: string | undefined;
}

/** A stable key for one audience, so a page's feeds compare and de-duplicate by value. */
export function audienceKey(audience: KakiAudience): string {
  return audience.kind === 'role' ? `role:${audience.role}` : audience.kind;
}

/** A link with no socket, so a hook call site stays unconditional when it has no feed. */
const inertLink: KakiLink = {
  subscribe: () => () => undefined,
  onOpen: () => () => undefined,
  send: () => false,
  isCurrent: () => false,
};

/** How one audience is written on the wire. */
function channelQuery(audience: KakiAudience): string {
  // Roles and shared feeds travel on separate channels: a role id may be any word, including
  // `participant`, so it can never be mistaken for the projection by its spelling.
  return audience.kind === 'role'
    ? `role=${encodeURIComponent(audience.role)}`
    : `audience=${encodeURIComponent(audience.kind)}`;
}

interface FeedRuntime {
  audience: KakiAudience;
  key: string;
  link: KakiLink;
  listeners: Set<(event: KakiEvent) => void>;
  openListeners: Set<(generation: number) => void>;
  socket: WebSocket | undefined;
  openSocket: WebSocket | undefined;
  reconnectTimer: number | undefined;
  attempts: number;
  generation: number;
  connected: boolean;
  ended: string | undefined;
  closed: boolean;
  endedForGood: boolean;
  publish(): void;
}

/**
 * One socket per feed, with its own reconnect, backoff, ended-meeting close and failed-reconnect
 * session check. A page shares each feed's runtime with every consumer of that feed.
 */
function useKakiLinks(feeds: readonly KakiAudience[] | undefined): ReadonlyMap<string, KakiFeed> {
  const scenario = useScenario();
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;
  const { meetingId } = useMeetingScope();
  const [states, setStates] = useState<ReadonlyMap<string, FeedState>>(() => new Map());
  const runtimes = useRef(new Map<string, FeedRuntime>());

  const publish = useCallback((runtime: FeedRuntime): void => {
    setStates((previous) => {
      const current = previous.get(runtime.key);
      if (current?.connected === runtime.connected && current?.ended === runtime.ended) {
        return previous;
      }
      const next = new Map(previous);
      next.set(runtime.key, { connected: runtime.connected, ended: runtime.ended });
      return next;
    });
  }, []);

  const keys = feeds === undefined ? [] : [...new Set(feeds.map(audienceKey))];
  /** A stable identity for the set, so a new array with the same feeds never reconnects. */
  const wire = feeds === undefined ? undefined : JSON.stringify(keys);

  if (feeds !== undefined) {
    for (const audience of feeds) {
      const key = audienceKey(audience);
      const existing = runtimes.current.get(key);
      if (existing === undefined) {
        const runtime = {
          audience,
          key,
          listeners: new Set<(event: KakiEvent) => void>(),
          openListeners: new Set<(generation: number) => void>(),
          socket: undefined,
          openSocket: undefined,
          reconnectTimer: undefined,
          attempts: 0,
          generation: 0,
          connected: false,
          ended: undefined,
          closed: false,
          endedForGood: false,
          publish: () => publish(runtime),
        } as FeedRuntime;
        runtime.link = {
          subscribe(listener) {
            runtime.listeners.add(listener);
            return () => {
              runtime.listeners.delete(listener);
            };
          },
          onOpen(listener) {
            runtime.openListeners.add(listener);
            return () => {
              runtime.openListeners.delete(listener);
            };
          },
          send(command) {
            const socket = runtime.socket;
            if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
            try {
              socket.send(JSON.stringify(command));
              return true;
            } catch {
              return false;
            }
          },
          isCurrent(generation) {
            return (
              runtime.openSocket?.readyState === WebSocket.OPEN && runtime.generation === generation
            );
          },
        };
        runtimes.current.set(key, runtime);
      } else {
        existing.audience = audience;
      }
    }
  }

  useEffect(() => {
    if (wire === undefined) return;
    const activeKeys = JSON.parse(wire) as string[];
    const active = new Set(activeKeys);

    for (const [key, runtime] of [...runtimes.current]) {
      if (active.has(key)) continue;
      stop(runtime);
      runtimes.current.delete(key);
    }

    function query(audience: KakiAudience): string {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}/ws?${channelQuery(audience)}&meeting=${encodeURIComponent(meetingId)}`;
    }

    function stop(runtime: FeedRuntime): void {
      runtime.closed = true;
      if (runtime.reconnectTimer !== undefined) {
        window.clearTimeout(runtime.reconnectTimer);
        runtime.reconnectTimer = undefined;
      }
      runtime.socket?.close();
      runtime.socket = undefined;
      runtime.openSocket = undefined;
      runtime.connected = false;
      runtime.ended = undefined;
      runtime.attempts = 0;
      runtime.endedForGood = false;
    }

    function connect(runtime: FeedRuntime): void {
      if (runtime.closed || runtime.endedForGood) return;
      let opened = false;
      const current = new WebSocket(query(runtime.audience));
      runtime.socket = current;

      current.addEventListener('open', () => {
        if (runtime.closed) return;
        opened = true;
        runtime.attempts = 0;
        runtime.openSocket = current;
        runtime.generation += 1;
        runtime.connected = true;
        runtime.ended = undefined;
        runtime.publish();
        for (const listener of [...runtime.openListeners]) {
          try {
            listener(runtime.generation);
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
        for (const listener of [...runtime.listeners]) {
          try {
            listener(event);
          } catch (error) {
            console.error('kaki web: an event listener failed', error);
          }
        }
      });

      current.addEventListener('close', (event) => {
        if (runtime.closed || runtime.endedForGood) return;
        if (runtime.openSocket === current) runtime.openSocket = undefined;
        runtime.connected = false;
        runtime.publish();
        const closeEvent = event as CloseEvent | undefined;
        if (closeEvent?.code === 4001) {
          runtime.endedForGood = true;
          if (runtime.reconnectTimer !== undefined) {
            window.clearTimeout(runtime.reconnectTimer);
            runtime.reconnectTimer = undefined;
          }
          runtime.ended = closeEvent.reason === '' ? MEETING_ENDED_MESSAGE : closeEvent.reason;
          runtime.publish();
          return;
        }
        if (!opened) {
          // A reconnect was refused before it opened. Ask whether this phone's meeting is gone;
          // otherwise the backoff below keeps retrying at a bounded pace.
          void fetchMe()
            .then((me) => {
              if (runtime.closed || runtime.endedForGood) return;
              if (me.authEnabled && me.kind === null && me.ended === true) {
                runtime.endedForGood = true;
                if (runtime.reconnectTimer !== undefined) {
                  window.clearTimeout(runtime.reconnectTimer);
                  runtime.reconnectTimer = undefined;
                }
                runtime.socket?.close();
                runtime.ended = MEETING_ENDED_MESSAGE;
                runtime.publish();
              }
            })
            .catch((error: unknown) => {
              console.warn('kaki web: could not re-check the session after a failed reconnect', error);
            });
        }
        if (runtime.endedForGood) return;
        const delay = Math.min(5000, 500 * 2 ** runtime.attempts);
        runtime.attempts += 1;
        runtime.reconnectTimer = window.setTimeout(() => connect(runtime), delay);
      });

      current.addEventListener('error', () => current.close());
    }

    for (const key of activeKeys) {
      const runtime = runtimes.current.get(key);
      if (runtime === undefined) continue;
      runtime.closed = false;
      runtime.endedForGood = false;
      runtime.connected = false;
      runtime.ended = undefined;
      runtime.attempts = 0;
      runtime.publish();
      connect(runtime);
    }

    return () => {
      for (const key of activeKeys) {
        const runtime = runtimes.current.get(key);
        if (runtime !== undefined) stop(runtime);
      }
    };
  }, [wire, meetingId, publish]);

  const links = new Map<string, KakiFeed>();
  for (const key of keys) {
    const runtime = runtimes.current.get(key);
    if (runtime === undefined) continue;
    const state = states.get(key);
    links.set(key, {
      link: runtime.link,
      connected: state?.connected ?? runtime.connected,
      ended: state?.ended ?? runtime.ended,
    });
  }
  return links;
}

/** One feed's link for a hook used outside a page provider; undefined keeps the call site quiet. */
export function useKakiLink(audience: KakiAudience | undefined): KakiLinkResult {
  const key = audience === undefined ? undefined : audienceKey(audience);
  const feeds = useMemo(
    () => (audience === undefined ? undefined : [audience]),
    // A new audience object with the same feed must not tear down the live socket.
    [key],
  );
  const links = useKakiLinks(feeds);
  const feed = key === undefined ? undefined : links.get(key);
  return {
    link: feed?.link ?? inertLink,
    connected: feed?.connected ?? false,
    ended: feed?.ended,
  };
}

const KakiConnectionContext = createContext<KakiConnectionValue | null>(null);

/**
 * Put one socket per distinct feed around a meeting page. Every `useKaki` beneath it subscribes to
 * the link for its own feed instead of opening a socket, so consumers of one feed share one wire.
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
  const feeds = useMemo<KakiAudience[]>(
    () => [
      sharedAudience === 'screen' ? { kind: 'screen' } : { kind: 'participant' },
      { kind: 'role', role },
      { kind: 'lifecycle' },
    ],
    [sharedAudience, role],
  );
  const links = useKakiLinks(feeds);
  const value = useMemo<KakiConnectionValue>(
    () => ({ feeds: links, seat: role }),
    [links, role],
  );
  return <KakiConnectionContext.Provider value={value}>{children}</KakiConnectionContext.Provider>;
}

/** The page's Kaki connections, or null outside a meeting page that provides them. */
export function useKakiConnection(): KakiConnectionValue | null {
  return useContext(KakiConnectionContext);
}
