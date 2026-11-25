/** The viewer's own zone as a short label such as "SGT", "GMT+8" or "UTC". */
export function localZoneAbbreviation(at: Date = new Date()): string {
  try {
    const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName');
    return zone?.value ?? '';
  } catch {
    return '';
  }
}

/** A meeting instant in the viewer's own clock, named in their own zone. */
export function formatMeetingTime(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const text = when.toLocaleString();
  const zone = localZoneAbbreviation(when);
  return zone === '' ? text : `${text} ${zone}`;
}
