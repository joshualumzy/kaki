import type { NpcProfile, Scenario } from '@kaki/shared';

/**
 * What a non-runner browser may see of the active scenario. `seat` is the role a signed-in
 * participant holds, or undefined for the shared screen and signed-out visitors. Hidden AI
 * material (agenda directions, every other seat's facts, role cards and private NPC notes) never
 * leaves the server for those audiences; the AI runner reads the full scenario through its
 * service-only route instead.
 */
export function projectScenario(scenario: Scenario, seat?: string): Scenario {
  const projected = structuredClone(scenario) as Scenario;

  for (const item of projected.agenda) {
    delete item.directions;
    if (seat === undefined || item.seatFacts?.[seat] === undefined) {
      delete item.seatFacts;
    } else {
      item.seatFacts = { [seat]: item.seatFacts[seat]! };
    }
  }

  for (const role of projected.roles) {
    if (seat === undefined || role.id !== seat) delete role.card;
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
