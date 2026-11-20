/** Remove the CRLF + whitespace a folded iCalendar line continues on. */
export function unfoldIcalLines(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, '');
}

/** Unescape one iCalendar TEXT value: `\n` becomes a newline, `\,` `\;` `\\` lose their slash. */
export function unescapeIcalText(text: string): string {
  return text.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

/** The body of every VEVENT in an unfolded calendar text. */
export function eventBodies(unfolded: string): string[] {
  const bodies: string[] = [];
  for (const part of unfolded.split(/BEGIN:VEVENT/i).slice(1)) {
    const end = part.search(/END:VEVENT/i);
    bodies.push(end === -1 ? part : part.slice(0, end));
  }
  return bodies;
}

/** One property line: its uppercased name, its whole head (with parameters), and its raw value. */
export interface IcalProperty {
  name: string;
  head: string;
  value: string;
}

/** Split an unfolded VEVENT body into properties; a line without a name and colon is skipped. */
export function eventProperties(body: string): IcalProperty[] {
  const properties: IcalProperty[] = [];
  for (const line of body.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const head = line.slice(0, colon);
    properties.push({ name: head.split(';')[0]!.toUpperCase(), head, value: line.slice(colon + 1) });
  }
  return properties;
}
