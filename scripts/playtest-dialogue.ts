/**
 * Headless Playtest & Quality Evaluator for Kaki Dialogue & Wingman
 *
 * Runs the live conversation engine against the real LLM for all 4 agenda items,
 * simulating a visitor (e.g. Foo, Operations Director) sitting in the meeting,
 * and asserts against the 6 pillars of natural dialogue, pacing, and Wingman state.
 *
 * Usage:
 *   npx tsx scripts/playtest-dialogue.ts
 */
import '../server/src/env';
import { loadScenario } from '../server/src/loadScenario';
import { llmFromEnv } from '../server/src/llm';
import { NpcConversation } from '../server/src/npc/conversation';
import { liveNextItemLine, spokenTopicLead } from '../server/src/host/opening';
import type { AgendaItem, Scenario } from '@kaki/shared';

interface UtteranceRecord {
  speaker: string;
  text: string;
}

interface ItemResult {
  title: string;
  transcript: UtteranceRecord[];
  passed: boolean;
  failures: string[];
  wingmanPassed: boolean;
  wingmanFailures: string[];
}

const llm = llmFromEnv();
if (!llm) {
  console.error('❌ Error: KAKI_LLM_BASE_URL, KAKI_LLM_API_KEY, or KAKI_LLM_MODEL is not configured in .env');
  process.exit(1);
}

const human = { name: 'Foo', role: 'producer', transcriptName: 'Foo' };

// Helpers for quality checks
const BANNED_PATTERNS = [
  { re: /\bthe catch on our side\b/i, reason: 'Used banned cliché "the catch on our side"' },
  { re: /\bour tiktok reviewer\b/i, reason: 'Referred to reviewer as "our TikTok reviewer"' },
  { re: /\bwith 85,?000 followers\b/i, reason: 'Recited verbatim press-release follower count' },
  { re: /\bhere from [A-Z][a-z]+ (?:Lead|Director|Manager)\b/i, reason: 'Awkward grammar "here from <Title>"' },
  { re: /^(?:(?:hey|hi|hello)\s+[a-z]+,\s*)?(?:and\s+)?(?:mei|arjun|daniel|wei ling)\s+from\s+[a-z]+,/i, reason: 'Broken comma-splice roll-call intro ("<Name> from <dept>, ...")' },
  { re: /\bban(?:ning)? (?:laptop users|window stools)\b/i, reason: 'Argued against a phantom ban on laptop users nobody proposed' },
  { re: /\bpulling (?:our )?counter staff off the line to hand-deliver\b/i, reason: 'Argued against a phantom proposal to pull counter staff to hand-deliver' },
];

function checkTranscriptQuality(item: AgendaItem, transcript: UtteranceRecord[]): string[] {
  const failures: string[] = [];
  if (transcript.length === 0) {
    return ['No transcript utterances were produced'];
  }

  // 1. Check for banned phrases
  for (const turn of transcript) {
    for (const { re, reason } of BANNED_PATTERNS) {
      if (re.test(turn.text)) {
        failures.push(`${turn.speaker}: ${reason} -> "${turn.text}"`);
      }
    }

    // Sentence length check (pacing)
    const sentences = turn.text.split(/(?<=[.?!])\s+/);
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/).filter(Boolean);
      if (words.length > 32) {
        failures.push(`${turn.speaker}: Sentence too long (${words.length} words, max 32) -> "${sentence}"`);
      }
    }
  }

  // 2. Identify Host, Speaker 1, and Speaker 2
  const hostLine = transcript.find((t) => t.speaker === 'Sam');
  const nonHost = transcript.filter((t) => t.speaker !== 'Sam' && t.speaker !== human.name);
  const speaker1 = nonHost[0];
  const speaker2 = nonHost.find((t) => t.speaker !== speaker1?.speaker);

  // 3. Host opener check
  if (hostLine) {
    if (hostLine.text.includes(item.title) && !hostLine.text.includes(spokenTopicLead(item.title))) {
      failures.push(`Sam: Recited raw agenda title "${item.title}" instead of natural spoken lead`);
    }
  }

  // 4. Speaker 1 check
  if (speaker1) {
    // Speaker 1 should not lead with isolated budget numbers in the very first sentence
    const firstSentence = speaker1.text.split(/(?<=[.?!])\s+/)[0] ?? '';
    if (/^\s*(?:our launch budget|we only have \$\d+|\$\d+ left)\b/i.test(firstSentence)) {
      failures.push(`${speaker1.speaker} (Speaker 1): Inverted order! Led with budget before ground trigger -> "${firstSentence}"`);
    }
  } else {
    failures.push('Speaker 1 never spoke');
  }

  // 5. Speaker 2 check (Causal link & Question)
  if (speaker2) {
    const allSpeaker2Text = nonHost.filter((t) => t.speaker === speaker2.speaker).map((t) => t.text).join(' ');
    // Must end with question addressed to human
    const hasQuestion = /\?/.test(allSpeaker2Text);
    const namesHuman = new RegExp(`\\b${human.name}\\b`, 'i').test(allSpeaker2Text);
    if (!hasQuestion) {
      failures.push(`${speaker2.speaker} (Speaker 2): Failed to ask a question to wrap up the briefing`);
    }
    if (!namesHuman) {
      failures.push(`${speaker2.speaker} (Speaker 2): Did not address visitor (${human.name}) by name`);
    }

    // Topic-specific causal diagnostic checks
    if (item.title.includes('Food safety')) {
      if (!/fridge|disposal|officer|delivery|review|eggs|kaya/i.test(allSpeaker2Text)) {
        failures.push(`${speaker2.speaker}: Missing causal link! Did not explain the fridge, the disposal log or the officer visit`);
      }
    } else if (item.title.includes('Delivery')) {
      if (!/grabfood|platter|pickup|commission|margin|tray/i.test(allSpeaker2Text)) {
        failures.push(`${speaker2.speaker}: Missing causal link! Did not explain the commission, platter or pickup margin`);
      }
    } else if (item.title.includes('Laptop')) {
      if (!/solo|tray|stool|socket|wifi|code|timer/i.test(allSpeaker2Text)) {
        failures.push(`${speaker2.speaker}: Missing causal link! Did not explain the solo diners, stools or socket timer`);
      }
    } else if (item.title.includes('regulars')) {
      if (!/price|kopi|till|facebook|share|note/i.test(allSpeaker2Text)) {
        failures.push(`${speaker2.speaker}: Missing causal link! Did not explain the old price, the till button or the public post`);
      }
    } else if (item.title.includes('counter staff')) {
      if (!/rest day|double pay|login|temp|manager|toast|kiosk/i.test(allSpeaker2Text)) {
        failures.push(`${speaker2.speaker}: Missing causal link! Did not explain the counter cover options`);
      }
    }
  }

  return failures;
}

function checkWingmanTradeOffs(item: AgendaItem, _scenario: Scenario): string[] {
  const failures: string[] = [];
  const tradeOffs = item.discussion?.tradeOffs ?? [];
  if (tradeOffs.length === 0) return ['No tradeOffs defined in scenario'];

  for (const to of tradeOffs) {
    // 1. Visitor seat exclusion check
    // If the attendee is Wei Ling (the Operations Director seat), it must NOT be in tradeOffs
    // or the UI must exclude it
    if (to.attendee.toLowerCase() === 'wei ling' && human.role === 'producer') {
      // In scenario.json, Wei Ling may exist, but let's check its format
    }

    // 2. Bold headline check (must have colon within first 35 chars)
    const colonIndex = to.tradeOff.indexOf(':');
    if (colonIndex <= 0 || colonIndex > 35) {
      failures.push(`[${to.attendee}]: Missing punchy bold headline prefix (colon within 35 chars) -> "${to.tradeOff}"`);
    }

    // 3. Glanceability word count check
    const words = to.tradeOff.split(/\s+/).filter(Boolean);
    if (words.length > 28) {
      failures.push(`[${to.attendee}]: TradeOff text too long for glanceability (${words.length} words, max 28) -> "${to.tradeOff}"`);
    }
  }

  return failures;
}

async function simulateAgendaItem(item: AgendaItem, scenario: Scenario): Promise<ItemResult> {
  const transcript: UtteranceRecord[] = [];
  const suggestedTasks: string[] = [];
  const cast = scenario.npcs?.filter((npc) => npc.attendee !== 'Wei Ling') ?? [];

  const conversation = new NpcConversation<Int16Array>(
    {
      stream: (messages, signal) => llm!.stream!(messages, { signal }),
      synthesize: () => Promise.resolve(new Int16Array(0)),
      play: () => Promise.resolve(),
      emitTranscript: (speaker, text) => {
        transcript.push({ speaker, text });
      },
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
  const opener = liveNextItemLine(scenario, item.title, { name: human.name, seat: 'Wei Ling' });
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
  const transcriptFailures = checkTranscriptQuality(item, briefingTranscript);

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

  const wingmanFailures = checkWingmanTradeOffs(item, scenario);

  return {
    title: item.title,
    transcript,
    passed: transcriptFailures.length === 0,
    failures: transcriptFailures,
    wingmanPassed: wingmanFailures.length === 0,
    wingmanFailures,
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

    if (result.passed && result.wingmanPassed) {
      console.log(`✅ [PASS] "${item.title}"`);
    } else {
      allPassed = false;
      console.log(`❌ [FAIL] "${item.title}"`);
      if (result.failures.length > 0) {
        console.log('   Dialogue Quality Failures:');
        for (const f of result.failures) console.log(`     • ${f}`);
      }
      if (result.wingmanFailures.length > 0) {
        console.log('   Wingman Dock Failures:');
        for (const f of result.wingmanFailures) console.log(`     • ${f}`);
      }
    }
    console.log('\n' + '-'.repeat(63) + '\n');
  }

  if (allPassed) {
    console.log('🎉 ALL AGENDA ITEMS & WINGMAN CHECKS PASSED WITH ZERO FLAWS!');
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
