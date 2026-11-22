/** The two initials a name shows on its coloured circle. */
export function initialsFor(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : (words[0]?.[1] ?? '');
  return `${first}${last}`.toUpperCase() || '?';
}

/** A stable hue for a name, so the same person always gets the same colour. */
export function colourFor(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return hash % 360;
}

/**
 * One person's picture everywhere the room names them: their Google photo when there is one,
 * otherwise initials on a circle whose colour is stable for their name.
 */
export function Avatar({
  name,
  photoUrl,
  size = 'md',
}: {
  name: string;
  photoUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const label = name.trim() === '' ? 'Guest' : name.trim();
  if (photoUrl !== undefined && photoUrl !== null && photoUrl.trim() !== '') {
    return (
      <img
        className="kaki-avatar"
        data-size={size}
        src={photoUrl}
        alt={label}
        referrerPolicy="no-referrer"
      />
    );
  }
  const hue = colourFor(label);
  return (
    <span
      className="kaki-avatar kaki-avatar-initials"
      data-size={size}
      role="img"
      aria-label={label}
      style={{ ['--avatar-hue' as string]: String(hue) }}
    >
      {initialsFor(label)}
    </span>
  );
}
