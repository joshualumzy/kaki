/** The parts of the browser's SpeechRecognition this app uses; lets tests supply a fake. */
export interface SpeechResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

export interface SpeechEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechResultLike };
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: SpeechEventLike) => void) | null;
  start(): void;
  stop(): void;
  abort?(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/**
 * Whether this page should run the browser's own speech recognition. By default the server recognises
 * the person's speech (NPC_STT=azure), so the page does not: running it too is redundant and Chrome's
 * recognition can make start-up sounds that the microphone picks up. `/demo?stt=browser` turns it on,
 * for a server started with NPC_STT=browser.
 */
export function browserRecognitionWanted(search: string): boolean {
  try {
    return new URLSearchParams(search).get('stt') === 'browser';
  } catch {
    return false;
  }
}

/** The browser's speech recognition, if it has one (Chrome and Edge do; Firefox does not). */
export function speechRecognitionCtor(win: object = window): SpeechRecognitionCtor | undefined {
  const holder = win as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return holder.SpeechRecognition ?? holder.webkitSpeechRecognition;
}

export interface RecognizerHandlers {
  /** One finished piece of speech, delivered exactly once. */
  onFinal(text: string): void;
  /** The words so far of the piece being spoken; empty when there is none. */
  onInterim?(text: string): void;
  onListening?(listening: boolean): void;
  /** Recognition cannot work (no permission, no microphone); it will not be retried. */
  onFatal?(message: string): void;
}

export interface RecognizerOptions {
  lang?: string;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
}

const FATAL: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked for speech recognition.',
  'service-not-allowed': 'Speech recognition is not allowed in this browser.',
  'audio-capture': 'No microphone was found for speech recognition.',
  'language-not-supported': 'Speech recognition does not support this language.',
};

/**
 * Run continuous speech recognition and keep it running. Browsers end a session every minute or
 * so, or after silence; this restarts it, backs off if it keeps failing, and never delivers a
 * finished piece of speech twice. Returns a function that stops it for good.
 */
export function startRecognizer(
  Recognition: SpeechRecognitionCtor,
  handlers: RecognizerHandlers,
  options: RecognizerOptions = {},
): () => void {
  const { lang = 'en-US', restartDelayMs = 250, maxRestartDelayMs = 5000 } = options;
  let stopped = false;
  let current: SpeechRecognitionLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  function scheduleRestart(): void {
    if (stopped) return;
    const delay = Math.min(maxRestartDelayMs, restartDelayMs * 2 ** failures);
    timer = setTimeout(begin, delay);
  }

  function begin(): void {
    timer = undefined;
    if (stopped) return;
    const recognition = new Recognition();
    current = recognition;
    // Results are numbered within a session; only those past this index are new.
    let delivered = 0;
    let startedAt = Date.now();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onstart = () => {
      startedAt = Date.now();
      handlers.onListening?.(true);
    };
    recognition.onresult = (event) => {
      failures = 0;
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result === undefined) continue;
        const text = result[0].transcript.trim();
        if (result.isFinal) {
          if (index >= delivered) {
            delivered = index + 1;
            if (text.length > 0) handlers.onFinal(text);
          }
        } else if (text.length > 0) {
          interim += `${interim ? ' ' : ''}${text}`;
        }
      }
      handlers.onInterim?.(interim);
    };
    recognition.onerror = (event) => {
      const fatal = FATAL[event.error];
      if (fatal !== undefined) {
        stopped = true;
        handlers.onFatal?.(fatal);
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        failures += 1; // for example "network": back off before trying again
      }
    };
    recognition.onend = () => {
      if (current === recognition) current = undefined;
      handlers.onListening?.(false);
      handlers.onInterim?.('');
      if (Date.now() - startedAt < 1000) failures += 1; // ended at once: something is wrong
      scheduleRestart();
    };

    try {
      recognition.start();
    } catch {
      failures += 1;
      current = undefined;
      scheduleRestart();
    }
  }

  begin();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const recognition = current;
    current = undefined;
    if (recognition !== undefined) {
      recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
      try {
        if (recognition.abort !== undefined) recognition.abort();
        else recognition.stop();
      } catch {
        // already stopped
      }
    }
    handlers.onListening?.(false);
    handlers.onInterim?.('');
  };
}
