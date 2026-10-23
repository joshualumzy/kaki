import { useCallback, useEffect, useRef, useState } from 'react';
import { isKakiEvent, type KakiCommand, type KakiEvent, type Role, type Task } from '@kaki/shared';
import { useScenario } from './ScenarioContext';

/** A command the server refused, with the reason to show the user. */
export interface KakiRejection {
  commandType: string;
  reason: string;
}

/** The live meeting state one page needs: non-task events, tasks, rejections and a send function. */
export interface UseKakiResult {
  events: KakiEvent[];
  tasks: Map<string, Task>;
  rejections: KakiRejection[];
  rejection: KakiRejection | null;
  connected: boolean;
  send(command: KakiCommand): void;
}

/** Subscribe to the server for one audience and keep the task list up to date. */
export function useKaki(audience: 'screen' | Role): UseKakiResult {
  const scenario = useScenario();
  const [events, setEvents] = useState<KakiEvent[]>([]);
  const [tasks, setTasks] = useState<Map<string, Task>>(() => new Map());
  const [rejections, setRejections] = useState<KakiRejection[]>([]);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const attempts = useRef(0);

  useEffect(() => {
    setEvents([]);
    setTasks(new Map());
    setRejections([]);
    setConnected(false);
    attempts.current = 0;
    let closed = false;
    let socket: WebSocket | undefined;

    function connect(): void {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws?role=${encodeURIComponent(audience)}`;
      const current = new WebSocket(url);
      socket = current;
      socketRef.current = current;

      current.addEventListener('open', () => {
        if (closed) return;
        attempts.current = 0;
        // The server is the source of truth: drop local state and rebuild from its catch-up,
        // so a restarted server never leaves stale task cards on screen.
        setEvents([]);
        setTasks(new Map());
        setConnected(true);
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
        if (!isKakiEvent(parsed, scenario)) {
          console.warn('kaki web: ignored an invalid event', parsed);
          return;
        }

        if (parsed.type === 'TASK_UPDATED') {
          const task = parsed.payload.task;
          setTasks((previous) => {
            const next = new Map(previous);
            next.set(task.id, task);
            return next;
          });
          return;
        }

        if (parsed.type === 'COMMAND_REJECTED') {
          setRejections((previous) => [...previous, parsed.payload].slice(-5));
          return;
        }

        setEvents((previous) => [...previous, parsed]);
      });

      current.addEventListener('close', () => {
        if (closed) return;
        setConnected(false);
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
      socketRef.current = undefined;
    };
  }, [audience, scenario]);

  const send = useCallback((command: KakiCommand) => {
    const socket = socketRef.current;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      setRejections((previous) =>
        [...previous, { commandType: command.type, reason: 'not connected' }].slice(-5),
      );
      return;
    }
    socket.send(JSON.stringify(command));
  }, []);

  return {
    events,
    tasks,
    rejections,
    rejection: rejections[rejections.length - 1] ?? null,
    connected,
    send,
  };
}
