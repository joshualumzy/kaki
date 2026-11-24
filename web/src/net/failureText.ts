import type { FailureCode } from '@kaki/shared';

/**
 * The one sentence a speech or device failure is shown with. A real meeting can offer typing, so it
 * may mention it; a practice meeting is speech only and never does. `ownSpeechFailed` is true only
 * when this viewer's own words were lost, so a room-wide outage never claims their line was missed.
 */
export function failureText(
  code: FailureCode,
  { real, ownSpeechFailed = false }: { real: boolean; ownSpeechFailed?: boolean },
): string {
  switch (code) {
    case 'speech-failed':
      return real
        ? 'Kaki could not hear that. Please say it again, or type it instead.'
        : 'Kaki could not hear that. Please say it again.';
    case 'speech-outage':
      if (!ownSpeechFailed) return 'Speech recognition is not working.';
      return real
        ? 'Speech recognition is not working. Your last line was not heard — say it again, or type it instead.'
        : 'Speech recognition is not working. Your last line was not heard — say it again.';
    case 'room-reconnecting':
      return 'Kaki lost its connection to the room. Reconnecting so everyone can be heard again.';
    case 'room-lost':
      return real
        ? 'Kaki lost its connection to the room and could not reconnect. Kaki cannot hear anyone; the runner is still trying.'
        : 'Kaki lost its connection to the room and could not reconnect. The AI colleagues cannot hear anyone; the runner is still trying.';
    case 'speech-unknown':
      return 'Speech recognition hit a problem.';
    case 'mic-blocked':
      return real
        ? "Your microphone is blocked. Allow it in your browser's site settings to take part."
        : "Your microphone is blocked. Allow it in your browser's site settings, then rejoin to speak.";
    case 'mic-missing':
      return 'No microphone was found. Connect one to speak in the meeting.';
    case 'camera-blocked':
      return "Your camera is blocked. Allow it in your browser's site settings to take part.";
    case 'camera-missing':
      return 'No camera was found.';
    case 'media-blocked':
      return real
        ? "Your microphone or camera is blocked. Allow it in your browser's site settings to take part."
        : "Your microphone (or camera) is blocked. Click the lock icon in the address bar to allow it in your browser's site settings, then rejoin to speak.";
    case 'mic-unsupported':
      return 'This browser cannot use a microphone here.';
    case 'camera-unsupported':
      return 'This browser cannot use a camera here.';
    case 'mic-failed':
      return 'The microphone could not be started.';
    case 'camera-failed':
      return 'The camera could not be started.';
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}
