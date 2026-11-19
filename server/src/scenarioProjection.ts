import { humanSeatRoles, type NpcProfile, type RoleCard, type Scenario } from '@kaki/shared';

/**
 * What a non-runner browser may see of the active scenario. `seat` is the role a signed-in
 * participant holds, or undefined for the shared screen and signed-out visitors. A playable
 * seat's `youAre` and `responsibility` stay public so the seat picker works; its facts, every
 * other seat's facts, agenda directions and private NPC notes never leave the server for those
 * audiences. The AI runner reads the full scenario through its service-only route instead.
 */
export function projectScenario(scenario: Scenario, seat?: string): Scenario {
  const projected = structuredClone(scenario) as Scenario;
  // The seats a person can take: their labels are public, their facts are not.
  const playable = new Set(humanSeatRoles(scenario).map((role) => role.id));

  for (const item of projected.agenda) {
    delete item.directions;
    if (seat === undefined || item.seatFacts?.[seat] === undefined) {
      delete item.seatFacts;
    } else {
      item.seatFacts = { [seat]: item.seatFacts[seat]! };
    }
  }

  for (const role of projected.roles) {
    if (role.card === undefined || role.id === seat) continue;
    if (playable.has(role.id)) {
      // The seat picker needs who the seat is and what it answers for; its facts stay with its holder.
      role.card = {
        youAre: role.card.youAre,
        responsibility: role.card.responsibility,
      } as RoleCard;
      continue;
    }
    // An AI-only seat's card is hidden from everyone but its own holder (who does not exist here).
    delete role.card;
  }

  if (projected.npcs !== undefined) {
    projected.npcs = projected.npcs.map(stripPrivateNpcFields);
  }

  return projected;
}

function stripPrivateNpcFields(npc: NpcProfile): NpcProfile {
  const publicNpc: NpcProfile = {
    attendee: npc.attendee,
    voice: npc.voice,
    personality: npc.personality,
    agenda: npc.agenda,
    concerns: [...npc.concerns],
    ...(npc.playable === undefined ? {} : { playable: npc.playable }),
    ...(npc.role === undefined ? {} : { role: npc.role }),
  };
  return publicNpc;
}
