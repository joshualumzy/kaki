/** "Arjun (Lead)" -> "Arjun": drop a trailing parenthesised role from a speaker label. */
export function speakerName(speaker: string): string {
  return speaker.replace(/\s*\([^)]*\)\s*$/, '').trim();
}
