/**
 * Headless Playtest & Quality Evaluator for Kaki Dialogue
 *
 * Runs the live conversation engine against the real LLM for all 4 agenda items,
 * simulating a visitor (e.g. Foo, Operations Director) sitting in the meeting,
 * and asserts against the pillars of natural dialogue and pacing.
 *
 * Usage:
 *   npx tsx scripts/playtest-dialogue.ts
 */
import '../server/src/env';
import { loadScenario } from '../server/src/core/loadScenario';
import { llmFromEnv } from '../server/src/services/llm';
import { NpcConversation } from '../server/src/npc/conversation';
import { liveNextItemLine } from '../server/src/host/opening';
import type { AgendaItem, Scenario } from '@kaki/shared';
import {
  checkTranscriptQuality, type UtteranceRecord,
} from './playtest-dialogue-checks';

interface ItemResult {
  title: string;
  transcript: UtteranceRecord[];
  passed: boolean;
  failures: string[];
}

const llm = llmFromEnv();
if (!llm) {
  console.error('❌ Error: KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY, or KAKI_LLM_MODEL is not configured in .env');
  process.exit(1);
}

const human = { name: 'Foo', role: 'operations_director', transcriptName: 'Foo', seat: 'Wei Ling' };

async function simulateAgendaItem(item: AgendaItem, scenario: Scenario): Promise<ItemResult> {
  const transcript: UtteranceRecord[] = [];
  const suggestedTasks: string[] = [];
  const cast = scenario.npcs?.filter((npc) => npc.attendee !== 'Wei Ling') ?? [];

  const conversation = new NpcConversation<Int16Array>(
    {
      stream: (messages, signal) => llm!.stream!(messages, { signal }),
      synthesize: () => Promise.resolve(new Int16Array(0)),
      play: () => Promise.resolve(),
      emitTranscript: (speaker, text, options) => {
        transcript.push({ speaker, text, ...(options?.catchId === undefined ? {} : { catchId: options.catchId }) });
      },
      emitTranscriptUpdate: () => undefined,
      emitState: () => {},
      log: (msg) => {
        if (msg.startsWith('proposal')) console.log(`    [assessment] ${msg}`);
      },
      describeMic: () => undefined,
      advanceAgenda: () => {},
      endMeeting: () => {},
      settleTopic: (input) => { suggestedTasks.push(input.title); },
    },
    {
      scenario: { ...scenario, npcs: cast },
      responseDelayMs: 0,
      speakerGapMs: 0,
      sentenceGapMs: 0,
      observeDelayMs: 0,
    },
  );

  conversation.setHuman(human);
  conversation.agendaMoved(item.title);

  // Sam speaks the opening lead
  const host = cast.find((npc) => npc.role === 'host')?.attendee ?? 'Sam';
  // Same as runner.ts: when a colleague briefs the item, Sam does not also hand it to someone by name.
  const opener = liveNextItemLine(scenario, item.title, { name: human.name, seat: 'Wei Ling' },
    conversation.briefsOnTopic(item.title));
  conversation.announce(host, opener);

  // Wait for the two colleagues to complete their briefing turn
  const start = Date.now();
  let lastTranscriptLen = 0;
  let quietSince = Date.now();

  while (Date.now() - start < 22_000) {
    const nonHost = transcript.filter((t) => t.speaker !== 'Sam' && t.speaker !== human.name);
    const distinctSpeakers = new Set(nonHost.map((t) => t.speaker));

    if (transcript.length !== lastTranscriptLen) {
      lastTranscriptLen = transcript.length;
      quietSince = Date.now();
    }

    if (distinctSpeakers.size >= 2) {
      const speaker1 = nonHost[0]!;
      const speaker2Utterances = nonHost.filter((t) => t.speaker !== speaker1.speaker);
      const speaker2Text = speaker2Utterances.map((t) => t.text).join(' ');

      // Finished once Speaker 2 has asked a question to the visitor
      if (speaker2Text.includes('?') && speaker2Text.toLowerCase().includes(human.name.toLowerCase())) {
        await new Promise((r) => setTimeout(r, 600));
        break;
      }

      // Or if it has gone quiet for > 3.5 seconds after both speakers appeared
      if (Date.now() - quietSince > 3500 && speaker2Utterances.length > 0) {
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Allow trailing stream to finalize
  await new Promise((r) => setTimeout(r, 800));
  const briefingTranscript = [...transcript];
  const transcriptFailures = checkTranscriptQuality(item, briefingTranscript, human, host);

  // Simulate multi-turn visitor proposal -> colleague response -> completion check on the first item
  if (item.title.includes('regulars')) {
    await conversation.settled();
    const preProposalLen = transcript.length;
    const partialLine = 'What if we add a regulars price on the till for the old uncles?';
    conversation.humanSpeech(true);
    conversation.humanSpeech(false);
    conversation.humanText(partialLine);

    const turn1Start = Date.now();
    while (Date.now() - turn1Start < 15_000) {
      const replies = transcript.slice(preProposalLen).filter((r) => r.speaker !== human.name);
      if (replies.some((r) => r.text.includes('?'))) {
        await new Promise((r) => setTimeout(r, 600));
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    await conversation.settled();

    const turn1Replies = transcript.slice(preProposalLen).filter((r) => r.speaker !== human.name);
    if (turn1Replies.length === 0) {
      transcriptFailures.push('Multi-turn check: Colleagues did not reply to visitor partial proposal');
    }

    const preTurn2Len = transcript.length;
    const completeLine =
      'Let us add a regulars price on the till tonight, keep the old kopi price explained at the counter, and Mei will test the rule before 8.';
    conversation.humanSpeech(true);
    conversation.humanSpeech(false);
    conversation.humanText(completeLine);

    const turn2Start = Date.now();
    while (Date.now() - turn2Start < 15_000) {
      const replies = transcript.slice(preTurn2Len).filter((r) => r.speaker !== human.name);
      if (replies.length > 0 && suggestedTasks.length > 0) {
        await new Promise((r) => setTimeout(r, 600));
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    await conversation.settled();

    if (suggestedTasks.length === 0) {
      transcriptFailures.push('Multi-turn check: Visitor got stuck! Complete proposal did not create a follow-up task');
    }
  }

  conversation.close();

  return {
    title: item.title,
    transcript,
    passed: transcriptFailures.length === 0,
    failures: transcriptFailures,
  };
}

async function main() {
  const scenario = await loadScenario('kopitiam');
  console.log('===============================================================');
  console.log('🧪 KAKI LIVE PLAYTEST EVALUATOR');
  console.log(`   Visitor: ${human.name} (${human.role})`);
  console.log(`   Model:   ${process.env.KAKI_LLM_MODEL}`);
  console.log('===============================================================\n');

  let allPassed = true;

  for (const item of scenario.agenda) {
    console.log(`▶ Testing Agenda Item: "${item.title}"...`);
    const result = await simulateAgendaItem(item, scenario);

    console.log('\n--- Transcript Generated ---');
    for (const t of result.transcript) {
      console.log(`  ${t.speaker.padEnd(8)}: ${t.text}`);
    }
    console.log('----------------------------\n');

    if (result.passed) {
      console.log(`✅ [PASS] "${item.title}"`);
    } else {
      allPassed = false;
      console.log(`❌ [FAIL] "${item.title}"`);
      if (result.failures.length > 0) {
        console.log('   Dialogue Quality Failures:');
        for (const f of result.failures) console.log(`     • ${f}`);
      }
    }
    console.log('\n' + '-'.repeat(63) + '\n');
  }

  if (allPassed) {
    console.log('🎉 ALL AGENDA ITEMS PASSED WITH ZERO DIALOGUE FLAWS!');
    process.exit(0);
  } else {
    console.error('💥 PLAYTEST FAILED ON ONE OR MORE QUALITY GATES.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal playtest error:', err);
  process.exit(1);
});
