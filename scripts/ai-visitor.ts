/** Model-backed guest and post-meeting judge for the existing live playtest driver. */
import '../server/src/env.ts';
import { createOpenAiLlm, LlmError, reasoningControlFromEnv, parseJsonReply, type ChatMessage, type CompleteOptions, type CompletionUsage } from '../server/src/llm';
import { roomReplyModelFromEnv } from './room-reply';
import { runLivePlaytest, type AnswerContext, type FinishContext, type Line, type PlaytestHooks } from './live-playtest';
import { behaviourForPersona, reversalLine, type Behaviour } from './playtest-behaviours';
import { guestIdentity, topicContext, transcriptText } from './visitor-context';
import { pathToFileURL } from 'node:url';

export const PERSONAS = ['hesitant', 'terse', 'off-topic', 'inventive', 'delegator', 'silent', 'interrupter', 'flip-flop', 'rejoin'] as const;
export type Persona = typeof PERSONAS[number];
type Score = { score: number; reason: string };
export type Judgement = {
  natural: Score;
  dynamic: Score;
  fun: Score;
  realistic: Score;
  contradictions: Array<{ line: string; reason: string }>;
  unsupported: Array<{ line: string; fact: string; reason: string }>;
  toneBreaches: Array<{ line: string; reason: string }>;
};
type Model = { completeWithUsage(messages: ChatMessage[], options?: CompleteOptions): Promise<{ content: string; usage?: CompletionUsage }> };
const scoreNames = ['natural', 'dynamic', 'fun', 'realistic'] as const;

function safeError(error: unknown): string {
  if (error instanceof LlmError) {
    const status = /HTTP \d{3}/.exec(error.message)?.[0];
    return status === undefined ? 'LLM request failed or timed out' : `LLM request failed with ${status}`;
  }
  return error instanceof Error ? error.message : 'Unknown AI playtest error';
}

const personaDirections: Record<Persona, string> = {
  hesitant: 'You are unsure, ask sincere questions, and commit slowly after hearing the trade-offs.',
  terse: 'Use very few words. You might say "ok" or "do it", but make your call intelligible in context.',
  'off-topic': 'Sometimes drift to a small unrelated thought, then return to the actual question and answer it.',
  inventive: 'Offer your own practical ideas and plausible new details. Mark guesses as guesses; do not rewrite established facts.',
  delegator: 'Make the call yourself, but hand the practical follow-up jobs to a named colleague in the room ("Daniel, can you call the supplier?") instead of doing them yourself.',
  silent: 'Stay quiet unless someone asks you directly by name, then answer briefly and concretely.',
  interrupter: 'Jump in while a colleague is still speaking, then answer the point they were making.',
  'flip-flop': 'Make a call, then change your mind once when a colleague pushes back, and settle on the second call.',
  rejoin: 'Step out briefly after the first decision, then come back and carry on as if you never left.',
};

export function visitorPrompt(persona: Persona, context: AnswerContext): ChatMessage[] {
  const topic = topicContext(context.scenario, context.role, context.topicTitle);
  return [
    { role: 'system', content: `${guestIdentity(context.scenario, context.role)}\nPersona: ${personaDirections[persona]}\nWrite only your next line as if typed in a live meeting. Keep it short, chatty, and specific. No speaker label, quotation marks, markdown, or stage directions. Stay consistent with established facts and your earlier lines. Respond to the latest exchange. Do not claim an action is complete unless the transcript says so.` },
    { role: 'user', content: `Current topic: ${context.topicTitle}\nBriefing: ${topic.briefing}\nDecision at hand: ${topic.decision}\nYour seat's known fact: ${topic.seatFact}\nImmediate purpose for your next line: ${context.intent}\nMeeting transcript so far:\n${transcriptText(context.transcript)}` },
  ];
}

export function judgePrompt(context: FinishContext): ChatMessage[] {
  if (context.scenario === undefined) throw new Error('AI judge needs the session scenario');
  const scenario = context.scenario;
  const canon = {
    organisation: scenario.organisation,
    situation: scenario.situation,
    background: scenario.background,
    cast: scenario.attendees.map((person) => ({
      name: person.name,
      role: scenario.roles.find((role) => role.id === person.role)?.label ?? person.role,
    })),
    characters: (scenario.npcs ?? []).map((npc) => ({
      name: npc.attendee,
      knows: npc.knows ?? [],
      worries: npc.concerns,
    })),
    topics: context.playedTopics.map((index) => scenario.agenda[index]).filter((topic) => topic !== undefined),
  };
  return [
    { role: 'system', content: `Judge this live meeting fairly from the complete transcript. Score natural (human-sounding dialogue), dynamic (responsive exchange), fun (engaging to watch), and realistic (credible opening-day decisions), each as an integer 1-5 with a one-line reason. Find contradictions with the supplied canon or an earlier transcript line. Quote the exact contradictory line.
Unsupported facts: list every number, price, time, quantity, name, place or concrete claim spoken by an AI character (not the guest, Robot Visitor) that is not in the canon and was not said earlier by the guest. It is fine to list nothing.
Tone on sensitive topics: for agenda items flagged "sensitive": true, list lines that joke, make light of the topic, blame the customer, or promise things not agreed. It is fine to list nothing.
Every line must quote an actual transcript line exactly. Return only JSON: {"natural":{"score":1,"reason":"..."},"dynamic":{"score":1,"reason":"..."},"fun":{"score":1,"reason":"..."},"realistic":{"score":1,"reason":"..."},"contradictions":[{"line":"exact quote","reason":"..."}],"unsupported":[{"line":"exact quote","fact":"...","reason":"..."}],"toneBreaches":[{"line":"exact quote","reason":"..."}]}. Use [] if none; do not invent findings.` },
    { role: 'user', content: `Scenario canon for topics actually played:\n${JSON.stringify(canon)}\n\nFull meeting transcript:\n${transcriptText(context.transcript)}` },
  ];
}

export function parseJudgement(text: string, transcript: Line[]): Judgement {
  let value: unknown;
  try { value = parseJsonReply(text); } catch { throw new Error('AI judge returned malformed JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('AI judge returned an invalid score object');
  const data = value as Record<string, unknown>;
  const scoreOf = (name: string): Score => {
    const item = data[name];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`AI judge missing ${name} score`);
    const { score, reason } = item as Record<string, unknown>;
    if (!Number.isInteger(score) || (score as number) < 1 || (score as number) > 5 || typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason)) {
      throw new Error(`AI judge returned invalid ${name} score or reason`);
    }
    return { score: score as number, reason: reason.trim() };
  };
  const quoted = (item: unknown, label: string): { line: string; reason: string } => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`AI judge returned an invalid ${label}`);
    const { line, reason } = item as Record<string, unknown>;
    if (typeof line !== 'string' || !line.trim() || typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason) || !transcript.some((entry) => entry.text.includes(line))) {
      throw new Error(`AI judge ${label} must quote an actual transcript line and give one-line reason`);
    }
    return { line, reason: reason.trim() };
  };
  if (!Array.isArray(data.contradictions)) throw new Error('AI judge missing contradictions list');
  const contradictions = data.contradictions.map((item: unknown) => quoted(item, 'contradiction'));
  if (!Array.isArray(data.unsupported)) throw new Error('AI judge missing unsupported list');
  const unsupported = data.unsupported.map((item: unknown) => {
    const { line, reason } = quoted(item, 'unsupported fact');
    const { fact } = item as Record<string, unknown>;
    if (typeof fact !== 'string' || !fact.trim() || /[\r\n]/.test(fact)) throw new Error('AI judge unsupported fact needs a one-line fact');
    return { line, fact: fact.trim(), reason };
  });
  if (!Array.isArray(data.toneBreaches)) throw new Error('AI judge missing toneBreaches list');
  const toneBreaches = data.toneBreaches.map((item: unknown) => quoted(item, 'tone breach'));
  return { natural: scoreOf('natural'), dynamic: scoreOf('dynamic'), fun: scoreOf('fun'), realistic: scoreOf('realistic'), contradictions, unsupported, toneBreaches };
}

export class AiVisitor implements PlaytestHooks {
  visitorCalls = 0;
  judgeCalls = 0;
  promptTokens = 0;
  completionTokens = 0;
  totalTokens = 0;
  judgement?: Judgement;
  /** The live-meeting behaviour this persona runs, if its name adds behaviour to the wording. */
  readonly behaviour?: Behaviour;

  /** The guest runs on the free primary model; the judge on a separate model so it does not score its own lines. */
  constructor(readonly persona: Persona, private readonly guest: Model, private readonly judge: Model = guest) {
    this.behaviour = behaviourForPersona(persona);
  }

  private async call(messages: ChatMessage[], maxTokens: number, kind: 'visitor' | 'judge'): Promise<string> {
    if (kind === 'visitor') {
      if (this.visitorCalls >= 40) throw new Error('AI visitor call cap reached (40 per persona)');
      this.visitorCalls += 1;
    } else {
      if (this.judgeCalls >= 1) throw new Error('AI judge call cap reached (1 per persona)');
      this.judgeCalls += 1;
    }
    const reply = await (kind === 'visitor' ? this.guest : this.judge).completeWithUsage(messages, { maxTokens, temperature: kind === 'visitor' ? 0.8 : 0, reasoningEffort: 'none' });
    if (reply.usage === undefined) throw new Error('AI model reply omitted token usage');
    this.promptTokens += reply.usage.promptTokens;
    this.completionTokens += reply.usage.completionTokens;
    this.totalTokens += reply.usage.totalTokens;
    if (!reply.content.trim()) throw new Error('AI model returned an empty reply');
    return reply.content.trim();
  }

  async answer(context: AnswerContext): Promise<string> {
    let lastError: unknown;
    const messages = visitorPrompt(this.persona, context);
    for (let attempt = 0; attempt < 2 && this.visitorCalls < 40; attempt += 1) {
      try {
        const raw = await this.call(messages, 96, 'visitor');
        let line = raw.replace(/^['"“”]+|['"“”]+$/g, '').trim();
        if (this.behaviour === 'flip-flop' && /scrap that|reverse your (?:last|previous) call/i.test(context.intent)) {
          line = reversalLine(line);
        }
        if (!line || /[\r\n]/.test(line) || line.length > 240) {
          // Tell the model what was wrong before the retry, and keep the rejected text so a failure shows it.
          messages.push({ role: 'assistant', content: raw }, { role: 'user', content: 'That was not one short line. Reply again with only your own next line: one line, under 200 characters, no other speakers.' });
          throw new Error(`AI visitor reply must be one short line; got: ${JSON.stringify(raw.slice(0, 200))}`);
        }
        return line;
      } catch (error) { lastError = error; }
    }
    throw new Error(`AI visitor failed after ${this.visitorCalls >= 40 ? 'reaching the 40-call cap' : 'two attempts'}: ${safeError(lastError)}`);
  }

  async finish(context: FinishContext): Promise<{ reportLines: string[]; summaryLines: string[] }> {
    if (context.scenario === undefined || context.transcript.length === 0) throw new Error('AI judge needs a played session transcript');
    // The one-call judge ceiling also bounds retries. A failed judge request fails the run.
    let response: string;
    try { response = await this.call(judgePrompt(context), 1000, 'judge'); }
    catch (error) { throw new Error(`AI judge call failed: ${safeError(error)}`); }
    this.judgement = parseJudgement(response, context.transcript);
    const j = this.judgement;
    return {
      reportLines: ['## AI judge', '', ...scoreNames.map((name) => `- ${name}: ${j[name].score}/5 — ${j[name].reason}`), '', '### Contradictions', '', ...(j.contradictions.length ? j.contradictions.map((item) => `- “${item.line}” — ${item.reason}`) : ['(none)']), '', '### Unsupported facts', '', ...(j.unsupported.length ? j.unsupported.map((item) => `- “${item.line}” — ${item.fact} — ${item.reason}`) : ['(none)']), '', '### Tone on sensitive topics', '', ...(j.toneBreaches.length ? j.toneBreaches.map((item) => `- “${item.line}” — ${item.reason}`) : ['(none)']), ''],
      summaryLines: [...scoreNames.map((name) => `${name}: ${j[name].score}/5 — ${j[name].reason}`), `contradictions: ${j.contradictions.length}`, `unsupported: ${j.unsupported.length}`, `tone breaches: ${j.toneBreaches.length}`],
    };
  }

  reportLines(): string[] {
    return ['## AI model usage', '', `- Persona: ${this.persona}`, `- Behaviour: ${this.behaviour ?? 'scripted wording only'}`, `- Calls: ${this.visitorCalls} visitor (cap 40), ${this.judgeCalls} judge (cap 1)`, `- Tokens reported by API: ${this.totalTokens} total (${this.promptTokens} prompt, ${this.completionTokens} completion)`, ''];
  }
}

function parseOptions(argv: string[]): { persona: Persona | 'all'; phone: boolean; maxMinutes: number } {
  let persona: Persona | 'all' | undefined;
  let phone = false;
  let maxMinutes = 25;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--persona' && argv[i + 1]) persona = argv[++i] as Persona;
    else if (argv[i] === '--phone') phone = true;
    else if (argv[i] === '--max-minutes' && argv[i + 1]) maxMinutes = Number(argv[++i]);
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (persona === undefined || (persona !== 'all' && !PERSONAS.includes(persona))) throw new Error(`Use --persona ${PERSONAS.join('|')}|all`);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes must be positive');
  return { persona, phone, maxMinutes };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  const env = process.env;
  const missing = ['KAKI_LLM_BASE_URL', 'KAKI_LLM_API_KEY', 'KAKI_LLM_MODEL', 'KAKI_LLM_FALLBACK_BASE_URL', 'KAKI_LLM_FALLBACK_API_KEY', 'KAKI_LLM_FALLBACK_MODEL'].filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing AI playtest configuration: ${missing.join(', ')}`);
  // Guest: the free primary slot the colleagues use. Judge: the paid fallback slot, one call per run.
  const guest = createOpenAiLlm({ baseUrl: env.KAKI_LLM_BASE_URL!, apiKey: env.KAKI_LLM_API_KEY!, model: env.KAKI_LLM_MODEL!,
    reasoningControl: reasoningControlFromEnv(env.KAKI_LLM_REASONING_CONTROL, 'KAKI_LLM_REASONING_CONTROL') });
  const judge = createOpenAiLlm({ baseUrl: env.KAKI_LLM_FALLBACK_BASE_URL!, apiKey: env.KAKI_LLM_FALLBACK_API_KEY!, model: env.KAKI_LLM_FALLBACK_MODEL!,
    reasoningControl: reasoningControlFromEnv(env.KAKI_LLM_FALLBACK_REASONING_CONTROL, 'KAKI_LLM_FALLBACK_REASONING_CONTROL') });
  const personas = options.persona === 'all' ? PERSONAS : [options.persona];
  const rows: string[] = [];
  let failed = false;
  for (const persona of personas) {
    const visitor = new AiVisitor(persona, guest, judge);
    const result = await runLivePlaytest({ role: 'producer', phone: options.phone, maxMinutes: options.maxMinutes }, visitor, roomReplyModelFromEnv());
    console.log(`AI usage (${persona}): ${visitor.visitorCalls} visitor calls, ${visitor.judgeCalls} judge calls, ${visitor.totalTokens} total tokens (${visitor.promptTokens} prompt, ${visitor.completionTokens} completion)`);
    const scores = visitor.judgement === undefined ? '—' : scoreNames.map((name) => visitor.judgement![name].score).join('/');
    rows.push(`| ${persona} | ${result.passed ? 'PASS' : 'FAIL'} | ${scores} | ${visitor.judgement?.contradictions.length ?? '—'} | ${visitor.visitorCalls}+${visitor.judgeCalls} | ${visitor.totalTokens} | ${result.reportPath} |`);
    if (!result.passed) failed = true;
  }
  if (options.persona === 'all') console.log(['| Persona | Result | Natural/Dynamic/Fun/Realistic | Contradictions | Calls | Tokens | Report |', '| --- | --- | --- | ---: | ---: | ---: | --- |', ...rows].join('\n'));
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
