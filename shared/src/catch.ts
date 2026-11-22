/** The agenda item and trade-off a catch id names, or undefined when it is not a catch id. */
export function catchPosition(
  id: string | undefined,
): { agendaIndex: number; tradeOffIndex: number } | undefined {
  if (id === undefined) return undefined;
  const parts = id.split(':');
  if (parts.length !== 3 || parts[1] !== 'catch') return undefined;
  const agendaIndex = Number(parts[0]);
  const tradeOffIndex = Number(parts[2]);
  if (!Number.isInteger(agendaIndex) || !Number.isInteger(tradeOffIndex)) return undefined;
  return { agendaIndex, tradeOffIndex };
}
