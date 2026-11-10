import { useEffect, useRef, useState } from 'react';
import { Orb } from './Orb';

export interface MediaChoice {
  microphone: boolean;
  camera: boolean;
}

export interface MediaPreviewProps {
  value: MediaChoice;
  onChange(next: MediaChoice): void;
  /** Called when the browser refuses a device, so the toggle can fall back to off and say why. */
  onProblem(message: string | undefined): void;
}

function describeFailure(kind: 'microphone' | 'camera', error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotFoundError') return `No ${kind} was found.`;
  if (name === 'NotAllowedError' || name === 'SecurityError') return `Allow the ${kind} in your browser to turn it on.`;
  return `The ${kind} could not be started.`;
}

/** Opens the camera while `on`, and returns the stream for the preview. */
function useCameraStream(on: boolean, fail: (message: string) => void): MediaStream | undefined {
  const [stream, setStream] = useState<MediaStream | undefined>();
  const failRef = useRef(fail);
  failRef.current = fail;
  useEffect(() => {
    if (!on) return undefined;
    let cancelled = false;
    let opened: MediaStream | undefined;
    navigator.mediaDevices
      ?.getUserMedia({ video: true, audio: false })
      .then((s) => {
        if (cancelled) s.getTracks().forEach((t) => t.stop());
        else {
          opened = s;
          setStream(s);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) failRef.current(describeFailure('camera', error));
      });
    if (navigator.mediaDevices === undefined) failRef.current('This browser cannot use a camera here.');
    return () => {
      cancelled = true;
      opened?.getTracks().forEach((t) => t.stop());
      setStream(undefined);
    };
  }, [on]);
  return stream;
}

/** Opens the microphone while `on`, and returns its current loudness from 0 to 1. */
function useMicrophoneLevel(on: boolean, fail: (message: string) => void): number {
  const [level, setLevel] = useState(0);
  const failRef = useRef(fail);
  failRef.current = fail;
  useEffect(() => {
    if (!on) return undefined;
    let cancelled = false;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    if (navigator.mediaDevices === undefined) {
      failRef.current('This browser cannot use a microphone here.');
      return undefined;
    }
    const audioSession = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (audioSession !== undefined && audioSession.type === 'playback') {
      try {
        audioSession.type = 'auto';
      } catch {
        // Ignore if unsupported
      }
    }
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(s).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
        }, 80);
      })
      .catch((error: unknown) => {
        if (!cancelled) failRef.current(describeFailure('microphone', error));
      });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close().catch(() => undefined);
      setLevel(0);
    };
  }, [on]);
  return level;
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function CameraIcon({ off }: { off: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="M15 10l6-3v10l-6-3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

/** Zoom-style pre-join: a preview of the camera, a loudness meter for the microphone, and a toggle for each. */
export function MediaPreview({ value, onChange, onProblem, name = '' }: MediaPreviewProps & { name?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const turnOff = (kind: keyof MediaChoice) => (message: string) => {
    onChange({ ...value, [kind]: false });
    onProblem(message);
  };
  const camera = useCameraStream(value.camera, turnOff('camera'));
  const level = useMicrophoneLevel(value.microphone, turnOff('microphone'));

  useEffect(() => {
    if (videoRef.current !== null) videoRef.current.srcObject = camera ?? null;
  }, [camera]);

  function toggle(kind: keyof MediaChoice): void {
    onProblem(undefined);
    onChange({ ...value, [kind]: !value[kind] });
  }

  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div className="kd-preview">
        <Orb state={value.microphone && level > 0.12 ? 'speaking' : 'idle'} level={level} />
        <video ref={videoRef} autoPlay muted playsInline aria-label="Camera preview" style={{ display: camera ? 'block' : 'none' }} />
        {!camera && <div className="kd-off">{value.camera ? 'Starting camera…' : 'Camera is off'}</div>}
        <span className="kd-tag">{name.trim() || 'Foo'}</span>
      </div>
      <div className="kd-controls">
        <button
          type="button"
          className="kd-toggle"
          aria-label="Microphone"
          aria-pressed={value.microphone}
          title={value.microphone ? 'Turn the microphone off' : 'Turn the microphone on'}
          onClick={() => toggle('microphone')}
        >
          <MicIcon off={!value.microphone} />
        </button>
        <button
          type="button"
          className="kd-toggle"
          aria-label="Camera"
          aria-pressed={value.camera}
          title={value.camera ? 'Turn the camera off' : 'Turn the camera on'}
          onClick={() => toggle('camera')}
        >
          <CameraIcon off={!value.camera} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="kd-meter-text">
            {value.microphone ? 'Say something to test your microphone' : 'Microphone off: you will type to the AI attendees'}
          </div>
          <div role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={Number(level.toFixed(2))} className="kd-meter">
            {Array.from({ length: 24 }, (_, i) => (
              <i key={i} data-on={level * 24 > i} data-hot={level * 24 > i && i > 18} style={{ height: `${30 + (i / 23) * 70}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
