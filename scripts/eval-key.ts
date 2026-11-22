import { parseJsonReply, type ChatMessage } from '../server/src/services/llm';

export const WINGMAN_KINDS = ['answer', 'given', 'asked_you', 'record'] as const;
export type WingmanKind = typeof WINGMAN_KINDS[number];
export const WINGMAN_URGENCIES = ['quiet', 'act_now'] as const;
export type WingmanUrgency = typeof WINGMAN_URGENCIES[number];

export type KeyWingmanMoment = { moment: string; kind: WingmanKind };
export type KeyTopic = {
  title: string;
  shouldNote: string[];
  shouldWingman: KeyWingmanMoment[];
  shouldOfferTool: string[];
  shouldStaySilent: string[];
};
export type AnswerKey = { scenario: string; meetingTitle?: string; topics: KeyTopic[] };

export type ReportTranscriptLine = { at: string; item: number; topic: string; speaker: string; text: string };
export type ReportWingmanNote = { at: string; item: number; topic: string; kind: string; urgency: string; title: string; text: string };
export type ReportDecision = { item: number; topic: string; text: string };
export type ReportTodo = {
  item: number; topic: string; title: string; owner: string;
  action: string; fitStatus: string; fitKind?: string; status: string;
};
export type ReportTaskCard = { id: string; topic: string; action: string; status: string; title: string; owner: string };
export type ReportMinutes = { present: boolean; title?: string; status?: string; body?: string };
export type ReportData = {
  transcript: ReportTranscriptLine[];
  wingmanNotes: ReportWingmanNote[];
  decisions: ReportDecision[];
  todos: ReportTodo[];
  minutes?: ReportMinutes;
  taskCards: ReportTaskCard[];
};

export type TopicEvidence = {
  topic: string;
  transcript: ReportTranscriptLine[];
  wingmanNotes: ReportWingmanNote[];
  decisions: ReportDecision[];
  todos: ReportTodo[];
  minutes?: ReportMinutes;
  cards: ReportTaskCard[];
};

export type FoundItem = { id: string; text: string };
export type PreparedTopic = {
  topic: KeyTopic;
  evidence: TopicEvidence;
  noteGold: string[];
  wingmanGold: KeyWingmanMoment[];
  toolGold: string[];
  silenceGold: string[];
  decisions: FoundItem[];
  todos: FoundItem[];
  wingman: FoundItem[];
  offers: FoundItem[];
  wingmanBreaches: FoundItem[];
  offerBreaches: FoundItem[];
  ignoredWingman: FoundItem[];
};

export type MatchEntry = { gold: number; applicable: boolean; found: string | null; reason: string };
export type SilenceEntry = { found: string; reason: string };
export type RawVerdict = {
  shouldNote: MatchEntry[];
  shouldWingman: MatchEntry[];
  shouldOfferTool: MatchEntry[];
  shouldStaySilent: SilenceEntry[];
};

export type CategoryHit = { gold: string; foundId: string; found: string; reason: string };
export type CategoryMiss = { gold: string };
export type CategoryFalseAlarm = { id: string; text: string; reason?: string };
export type CategoryScore = {
  goldCount: number;
  applicableCount: number;
  hits: CategoryHit[];
  misses: Array<CategoryMiss & { reason: string }>;
  notApplicable: Array<CategoryMiss & { reason: string }>;
  falseAlarms: CategoryFalseAlarm[];
  recall: number | null;
};
export type SilenceScore = {
  falseAlarms: Array<{ id: string; text: string; reason: string }>;
  ignored: Array<{ id: string; reason: string }>;
};
export type TopicVerdict = {
  topic: string;
  emptyWorkspace: boolean;
  shouldNote: CategoryScore;
  shouldWingman: CategoryScore;
  shouldOfferTool: CategoryScore;
  shouldStaySilent: SilenceScore;
  notetaker: { decisions: number; todos: number; minutes: boolean };
  ignoredWingmanNotes: number;
};

export type CategoryTotals = {
  gold: number; applicable: number; hits: number; misses: number; notApplicable: number; falseAlarms: number; recall: number | null;
};
export type Totals = {
  shouldNote: CategoryTotals;
  shouldWingman: CategoryTotals;
  shouldOfferTool: CategoryTotals;
  shouldStaySilent: { falseAlarms: number };
  notetaker: { decisions: number; todos: number; minutesPresent: number; topics: number };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((item, index) => nonEmptyString(item, `${label}[${index}]`));
}

function wingmanKind(value: unknown, label: string): WingmanKind {
  if (typeof value !== 'string' || !(WINGMAN_KINDS as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of ${WINGMAN_KINDS.join(', ')}`);
  }
  return value as WingmanKind;
}

/** Validate the judge-only answer key loaded from planning/. */
export function parseAnswerKey(value: unknown): AnswerKey {
  if (!isObject(value)) throw new Error('answer key must be a JSON object');
  const scenario = nonEmptyString(value.scenario, 'answer key scenario');
  const meetingTitle = value.meetingTitle === undefined ? undefined : nonEmptyString(value.meetingTitle, 'answer key meetingTitle');
  if (!Array.isArray(value.topics) || value.topics.length === 0) throw new Error('answer key topics must be a non-empty list');
  const seen = new Set<string>();
  const topics = value.topics.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`topics[${index}] must be an object`);
    const title = nonEmptyString(entry.title, `topics[${index}].title`);
    if (seen.has(title)) throw new Error(`answer key repeats topic "${title}"`);
    seen.add(title);
    if (!Array.isArray(entry.shouldWingman)) throw new Error(`topics[${index}].shouldWingman must be a list`);
    return {
      title,
      shouldNote: stringList(entry.shouldNote, `topics[${index}].shouldNote`),
      shouldWingman: entry.shouldWingman.map((moment, momentIndex) => {
        if (!isObject(moment)) throw new Error(`topics[${index}].shouldWingman[${momentIndex}] must be an object`);
        return {
          moment: nonEmptyString(moment.moment, `topics[${index}].shouldWingman[${momentIndex}].moment`),
          kind: wingmanKind(moment.kind, `topics[${index}].shouldWingman[${momentIndex}].kind`),
        };
      }),
      shouldOfferTool: stringList(entry.shouldOfferTool, `topics[${index}].shouldOfferTool`),
      shouldStaySilent: stringList(entry.shouldStaySilent, `topics[${index}].shouldStaySilent`),
    };
  });
  return { scenario, ...(meetingTitle === undefined ? {} : { meetingTitle }), topics };
}

function sectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  const level = /^#+/.exec(heading.trim())?.[0].length ?? 2;
  const out: string[] = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (!fenced) {
      const match = /^(#+)\s/.exec(line);
      if (match !== null && match[1]!.length <= level) break;
    }
    out.push(line);
  }
  return out;
}

function itemPrefix(line: string): { item: number; topic: string; rest: string } | undefined {
  const match = /^-\s+\[item\s+(\d+)\s+·\s+(.*?)\]\s+(.*)$/.exec(line);
  if (match === null) return undefined;
  return { item: Number(match[1]), topic: match[2]!.trim(), rest: match[3]!.trim() };
}

function parseTranscriptLine(line: string): ReportTranscriptLine | undefined {
  const withTopic = /^-\s+(\S+)\s+\(source\s+(.*?),\s+item\s+(\d+)\)\s+\[(.*?)\]\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
  if (withTopic !== null) {
    return { at: withTopic[1]!, item: Number(withTopic[3]), topic: withTopic[4]!.trim(), speaker: withTopic[5]!, text: withTopic[6]! };
  }
  const legacy = /^-\s+(\S+)\s+\(source\s+(.*?),\s+item\s+(\d+)\)\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
  if (legacy === null) return undefined;
  return { at: legacy[1]!, item: Number(legacy[3]), topic: '', speaker: legacy[4]!, text: legacy[5]! };
}

function parseWingmanLine(line: string): ReportWingmanNote | undefined {
  const parts = line.slice(2).split(' · ');
  if (parts.length < 5) return undefined;
  const [at, itemPart, topic, kindPart, ...rest] = parts;
  const itemMatch = /^item (\d+)$/.exec(itemPart ?? '');
  if (at === undefined || itemMatch === null || topic === undefined || kindPart === undefined || rest.length === 0) return undefined;
  const [kind, urgency] = kindPart.split('/');
  if (kind === undefined || urgency === undefined) return undefined;
  const body = rest.join(' · ');
  const dash = body.indexOf(' — ');
  return {
    at,
    item: Number(itemMatch[1]),
    topic,
    kind,
    urgency,
    title: dash < 0 ? body : body.slice(0, dash),
    text: dash < 0 ? '' : body.slice(dash + 3),
  };
}

function parseTodo(prefix: { item: number; topic: string; rest: string }): ReportTodo {
  const match = /^(.*?) · owner (.*?) · action (.*?) · fit (.*?) · status (.*)$/.exec(prefix.rest);
  if (match === null) {
    return { item: prefix.item, topic: prefix.topic, title: prefix.rest, owner: 'unknown', action: 'unknown', fitStatus: 'unknown', status: 'unknown' };
  }
  const fit = match[4]!.trim();
  const fitKind = /\(([^)]+)\)\s*$/.exec(fit)?.[1];
  return {
    item: prefix.item,
    topic: prefix.topic,
    title: match[1]!.trim(),
    owner: match[2]!.trim(),
    action: match[3]!.trim(),
    fitStatus: fit.replace(/\s*\([^)]*\)\s*$/, '').trim(),
    ...(fitKind === undefined ? {} : { fitKind }),
    status: match[5]!.trim(),
  };
}

function parseMinutes(lines: string[]): ReportMinutes | undefined {
  const present = lines.find((line) => line.startsWith('- present:'));
  if (present === undefined) return undefined;
  const match = /^- present:\s+(.*?)\s+\(([^)]+)\)\s*$/.exec(present);
  const fenceStart = lines.findIndex((line) => line.trim() === '```markdown');
  let body: string | undefined;
  if (fenceStart >= 0) {
    const fenceEnd = lines.findIndex((line, index) => index > fenceStart && line.trim() === '```');
    if (fenceEnd > fenceStart) body = lines.slice(fenceStart + 1, fenceEnd).join('\n');
  }
  return {
    present: true,
    ...(match === null ? {} : { title: match[1]!, status: match[2]! }),
    ...(body === undefined ? {} : { body }),
  };
}

function parseCard(line: string): ReportTaskCard | undefined {
  const parts = line.slice(2).split(' · ');
  if (parts.length < 6) return undefined;
  const [id, topic, action, status, title, ownerPart] = parts;
  if (id === undefined || topic === undefined || action === undefined || status === undefined || title === undefined || ownerPart === undefined) return undefined;
  return { id, topic, action, status, title, owner: ownerPart.replace(/^owner\s+/, '') };
}

/** Parse the sections of a live playtest Markdown report that the answer-key judge reads. */
export function parseReport(markdown: string): ReportData {
  const transcript = sectionLines(markdown, '## Full API transcript')
    .map(parseTranscriptLine)
    .filter((line): line is ReportTranscriptLine => line !== undefined);
  const wingmanNotes = sectionLines(markdown, '## Wingman notes seen')
    .map(parseWingmanLine)
    .filter((note): note is ReportWingmanNote => note !== undefined);
  const notetaker = sectionLines(markdown, '## Notetaker output');
  const decisions = sectionLines(notetaker.join('\n'), '### Decisions')
    .map(itemPrefix)
    .filter((prefix): prefix is { item: number; topic: string; rest: string } => prefix !== undefined)
    .map((prefix) => ({ item: prefix.item, topic: prefix.topic, text: prefix.rest }));
  const todos = sectionLines(notetaker.join('\n'), '### To-dos')
    .map(itemPrefix)
    .filter((prefix): prefix is { item: number; topic: string; rest: string } => prefix !== undefined)
    .map(parseTodo);
  const minutes = parseMinutes(sectionLines(notetaker.join('\n'), '### Minutes'));
  const taskCards = sectionLines(markdown, '## Task cards seen (latest API state)')
    .map(parseCard)
    .filter((card): card is ReportTaskCard => card !== undefined);
  return { transcript, wingmanNotes, decisions, todos, ...(minutes === undefined ? {} : { minutes }), taskCards };
}

/** The report evidence that belongs to one agenda topic. */
export function evidenceForTopic(report: ReportData, topic: string): TopicEvidence {
  return {
    topic,
    transcript: report.transcript.filter((line) => line.topic === topic),
    wingmanNotes: report.wingmanNotes.filter((note) => note.topic === topic),
    decisions: report.decisions.filter((decision) => decision.topic === topic),
    todos: report.todos.filter((todo) => todo.topic === topic),
    ...(report.minutes === undefined ? {} : { minutes: report.minutes }),
    cards: report.taskCards.filter((card) => card.topic === topic),
  };
}

/** Split found evidence and gold expectations into the scored and disallowed sets for one judge call. */
export function prepareTopic(topic: KeyTopic, evidence: TopicEvidence, emptyWorkspace: boolean): PreparedTopic {
  const decisions = evidence.decisions.map((decision, index) => ({ id: `D${index + 1}`, text: decision.text }));
  const todos = evidence.todos.map((todo, index) => ({
    id: `T${index + 1}`,
    text: `${todo.title} — owner ${todo.owner}${todo.action === 'none' ? '' : ` — action ${todo.action}`} — status ${todo.status}`,
  }));
  const wingman: FoundItem[] = [];
  const wingmanBreaches: FoundItem[] = [];
  const ignoredWingman: FoundItem[] = [];
  evidence.wingmanNotes.forEach((note, index) => {
    const id = `W${index + 1}`;
    const text = `kind=${note.kind} urgency=${note.urgency} — ${note.title}: ${note.text}`;
    if (emptyWorkspace) {
      if (note.kind === 'asked_you' || note.kind === 'given') wingman.push({ id, text });
      else wingmanBreaches.push({ id, text });
      return;
    }
    if (note.kind === 'answer') ignoredWingman.push({ id, text });
    else wingman.push({ id, text });
  });
  const rawOffers = evidence.todos
    .map((todo, index) => ({ id: `O${index + 1}`, todo }))
    .filter((entry) => entry.todo.fitStatus === 'ready' && entry.todo.fitKind !== undefined);
  const offers = emptyWorkspace ? [] : rawOffers.map(({ id, todo }) => ({ id, text: `${todo.title} — ${todo.fitKind!}` }));
  const offerBreaches = emptyWorkspace ? rawOffers.map(({ id, todo }) => ({ id, text: `${todo.title} — ${todo.fitKind!}` })) : [];
  return {
    topic,
    evidence,
    noteGold: topic.shouldNote,
    wingmanGold: emptyWorkspace ? topic.shouldWingman.filter((moment) => moment.kind === 'asked_you' || moment.kind === 'given') : topic.shouldWingman,
    toolGold: emptyWorkspace ? [] : topic.shouldOfferTool,
    silenceGold: topic.shouldStaySilent,
    decisions,
    todos,
    wingman,
    offers,
    wingmanBreaches,
    offerBreaches,
    ignoredWingman,
  };
}

function numbered(items: readonly string[]): string {
  return items.length === 0 ? '(none)' : items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function numberedWingman(items: readonly KeyWingmanMoment[]): string {
  return items.length === 0 ? '(none)' : items.map((item, index) => `${index + 1}. ${item.moment} [${item.kind}]`).join('\n');
}

function numberedFound(items: readonly FoundItem[]): string {
  return items.length === 0 ? '(none)' : items.map((item) => `${item.id}. ${item.text}`).join('\n');
}

function systemPrompt(emptyWorkspace: boolean): string {
  return [
    'You are judging one agenda topic of a practice meeting against a judge-only answer key.',
    'Score by meaning, never by shared keywords. A hit must do the same job as the key item; a related or near-miss item is not a hit.',
    'The found ids are fixed: shouldNote uses D# (decision) and T# (to-do); shouldWingman uses W# (proactive private note); shouldOfferTool uses O# (a to-do showing a tool button).',
    'For every positive key list, return one entry per key item, in order. Set applicable to false when the transcript does not contain the decision, to-do or moment the key item describes; then found must be null. Set applicable to true when it did occur, and give the found id that matches it or null when it was not recorded.',
    'shouldStaySilent: list every found id, from any of D#/T#/W#/O#, that should not have happened because it matches a stay-silent key item or is otherwise an unjustified extra on this topic. Give one short reason. Never list a found id that is a genuine hit for a positive key item.',
    'Answers to the guest\'s own questions are not scored and are not listed as W# items.',
    emptyWorkspace
      ? 'This meeting ran in an empty workspace with no records. Only a to-do handed to the guest (given) or a direct ask by name (asked you) may raise a Wingman note; a note citing workspace records is a false alarm. No tool button should be offered.'
      : 'The workspace has records, so a record note can be correct when it answers or contradicts what is being decided.',
    'Never invent a found id. Return only this JSON object:',
    '{"shouldNote":[{"gold":1,"applicable":true,"found":"T1","reason":"..."}],"shouldWingman":[{"gold":1,"applicable":true,"found":"W1","reason":"..."}],"shouldOfferTool":[{"gold":1,"applicable":false,"found":null,"reason":"..."}],"shouldStaySilent":[{"found":"W2","reason":"..."}]}',
    'Use found null when nothing matches, applicable false when the moment never occurred, and [] when nothing should have been silent.',
  ].join('\n');
}

/** The one judge prompt for a topic; every found item and gold item the model may name is shown here. */
export function judgePrompt(prepared: PreparedTopic, emptyWorkspace: boolean): ChatMessage[] {
  const transcript = prepared.evidence.transcript.length === 0
    ? '(no lines)'
    : prepared.evidence.transcript.map((line) => `[item ${line.item}] ${line.speaker}: ${line.text}`).join('\n');
  const minutes = prepared.evidence.minutes === undefined || prepared.evidence.minutes.present !== true
    ? '(no minutes)'
    : minutesExcerpt(prepared.evidence.minutes);
  const user = [
    `Topic: ${prepared.topic.title}`,
    '',
    'Transcript:',
    transcript,
    '',
    'Private Wingman notes seen (proactive only):',
    numberedFound(prepared.wingman),
    '',
    `Answers to the guest's own questions (not scored): ${prepared.ignoredWingman.length}`,
    '',
    'Notetaker decisions:',
    numberedFound(prepared.decisions),
    '',
    'Notetaker to-dos:',
    numberedFound(prepared.todos),
    '',
    'Tool offers on to-dos:',
    numberedFound(prepared.offers),
    '',
    'Minutes kept by the meeting:',
    minutes,
    '',
    'Task cards shown in the meeting (same source as the notetaker output):',
    prepared.evidence.cards.length === 0 ? '(none)' : prepared.evidence.cards.map((card) => `- ${card.id} · ${card.topic} · ${card.action} · ${card.status} · ${card.title} · owner ${card.owner}`).join('\n'),
    '',
    'Key expectations:',
    'shouldNote:',
    numbered(prepared.noteGold),
    '',
    'shouldWingman:',
    numberedWingman(prepared.wingmanGold),
    '',
    'shouldOfferTool:',
    numbered(prepared.toolGold),
    '',
    'shouldStaySilent:',
    numbered(prepared.silenceGold),
    '',
    'Return the JSON object now.',
  ].join('\n');
  return [
    { role: 'system', content: systemPrompt(emptyWorkspace) },
    { role: 'user', content: user },
  ];
}

/** The minutes' real content: its kept to-dos and open questions, without the agenda prompts or duplicated transcript. */
export function minutesExcerpt(minutes: ReportMinutes): string {
  if (minutes.body === undefined) return `${minutes.title ?? 'Minutes'} (${minutes.status ?? 'present'})`;
  const lines = minutes.body.split(/\r?\n/);
  const transcript = lines.findIndex((line) => line.trim() === '## Discussion Transcript');
  const withoutTranscript = transcript < 0 ? lines : lines.slice(0, transcript);
  const agenda = withoutTranscript.findIndex((line) => line.trim() === '## Agenda Covered');
  let excerpt = withoutTranscript;
  if (agenda >= 0) {
    const next = withoutTranscript.findIndex((line, index) => index > agenda && /^##\s/.test(line.trim()));
    excerpt = [...withoutTranscript.slice(0, agenda), ...(next < 0 ? [] : withoutTranscript.slice(next))];
  }
  return excerpt.join('\n').trim() || `${minutes.title ?? 'Minutes'} (${minutes.status ?? 'present'})`;
}

function readMatches(value: unknown, goldCount: number, validIds: ReadonlySet<string>, label: string): MatchEntry[] {
  if (!Array.isArray(value)) throw new Error(`judge reply is missing the "${label}" list`);
  if (value.length !== goldCount) throw new Error(`judge reply has ${value.length} ${label} entries for ${goldCount} key items`);
  return value.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`${label}[${index}] must be an object`);
    if (entry.gold !== index + 1) throw new Error(`${label}[${index}].gold must be ${index + 1} (one entry per key item, in order)`);
    if (typeof entry.applicable !== 'boolean') throw new Error(`${label}[${index}].applicable must be true or false`);
    const reason = nonEmptyString(entry.reason, `${label}[${index}].reason`);
    if (entry.applicable === false) {
      if (entry.found !== null) throw new Error(`${label}[${index}].found must be null when applicable is false`);
      return { gold: index + 1, applicable: false, found: null, reason };
    }
    if (entry.found === null) return { gold: index + 1, applicable: true, found: null, reason };
    if (typeof entry.found !== 'string' || !validIds.has(entry.found)) {
      throw new Error(`${label}[${index}].found must be null or one of the shown ids: ${[...validIds].join(', ') || '(none)'}`);
    }
    return { gold: index + 1, applicable: true, found: entry.found, reason };
  });
}

/** Validate the judge's one JSON reply against the ids and key items actually sent. */
export function parseJudgeReply(text: string, prepared: PreparedTopic): RawVerdict {
  let value: unknown;
  try {
    value = parseJsonReply(text);
  } catch {
    throw new Error('judge reply is not valid JSON');
  }
  if (!isObject(value)) throw new Error('judge reply must be a JSON object');
  const noteIds = new Set([...prepared.decisions, ...prepared.todos].map((item) => item.id));
  const wingmanIds = new Set(prepared.wingman.map((item) => item.id));
  const offerIds = new Set(prepared.offers.map((item) => item.id));
  const allIds = new Set([...noteIds, ...wingmanIds, ...offerIds]);
  const shouldNote = readMatches(value.shouldNote, prepared.noteGold.length, noteIds, 'shouldNote');
  const shouldWingman = readMatches(value.shouldWingman, prepared.wingmanGold.length, wingmanIds, 'shouldWingman');
  const shouldOfferTool = readMatches(value.shouldOfferTool, prepared.toolGold.length, offerIds, 'shouldOfferTool');
  if (!Array.isArray(value.shouldStaySilent)) throw new Error('judge reply is missing the "shouldStaySilent" list');
  const seen = new Set<string>();
  const shouldStaySilent = value.shouldStaySilent.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`shouldStaySilent[${index}] must be an object`);
    if (typeof entry.found !== 'string' || !allIds.has(entry.found)) {
      throw new Error(`shouldStaySilent[${index}].found must be one of the shown ids: ${[...allIds].join(', ') || '(none)'}`);
    }
    if (seen.has(entry.found)) throw new Error(`shouldStaySilent names ${entry.found} more than once`);
    seen.add(entry.found);
    return { found: entry.found, reason: nonEmptyString(entry.reason, `shouldStaySilent[${index}].reason`) };
  });
  return { shouldNote, shouldWingman, shouldOfferTool, shouldStaySilent };
}

function categoryScore(
  gold: readonly string[],
  entries: readonly MatchEntry[],
  found: readonly FoundItem[],
  breaches: readonly FoundItem[],
  label: string,
): CategoryScore {
  const byId = new Map(found.map((item) => [item.id, item]));
  const paired = new Set<string>();
  const hits: CategoryHit[] = [];
  const misses: CategoryScore['misses'] = [];
  const notApplicable: CategoryScore['notApplicable'] = [];
  entries.forEach((entry, index) => {
    const goldText = gold[index]!;
    if (!entry.applicable) {
      notApplicable.push({ gold: goldText, reason: entry.reason });
      return;
    }
    if (entry.found === null) {
      misses.push({ gold: goldText, reason: entry.reason });
      return;
    }
    const item = byId.get(entry.found);
    if (item === undefined) throw new Error(`${label} matched ${entry.found} outside its found list`);
    paired.add(entry.found);
    hits.push({ gold: goldText, foundId: item.id, found: item.text, reason: entry.reason });
  });
  const applicableCount = hits.length + misses.length;
  return {
    goldCount: gold.length,
    applicableCount,
    hits,
    misses,
    notApplicable,
    falseAlarms: [
      ...found.filter((item) => !paired.has(item.id)).map((item) => ({ id: item.id, text: item.text })),
      ...breaches.map((item) => ({ id: item.id, text: item.text, reason: 'not allowed in an empty workspace' })),
    ],
    recall: applicableCount === 0 ? null : hits.length / applicableCount,
  };
}

function silenceScore(prepared: PreparedTopic, raw: RawVerdict): SilenceScore {
  const all = [...prepared.decisions, ...prepared.todos, ...prepared.wingman, ...prepared.offers];
  const byId = new Map(all.map((item) => [item.id, item]));
  const paired = new Set(
    [...raw.shouldNote, ...raw.shouldWingman, ...raw.shouldOfferTool]
      .flatMap((entry) => entry.found === null ? [] : [entry.found]),
  );
  const falseAlarms: SilenceScore['falseAlarms'] = [];
  const ignored: SilenceScore['ignored'] = [];
  for (const entry of raw.shouldStaySilent) {
    if (paired.has(entry.found)) {
      ignored.push({ id: entry.found, reason: entry.reason });
      continue;
    }
    falseAlarms.push({ id: entry.found, text: byId.get(entry.found)?.text ?? entry.found, reason: entry.reason });
  }
  const listed = new Set(falseAlarms.map((entry) => entry.id));
  for (const breach of [...prepared.wingmanBreaches, ...prepared.offerBreaches]) {
    if (listed.has(breach.id)) continue;
    falseAlarms.push({
      id: breach.id,
      text: breach.text,
      reason: breach.id.startsWith('W')
        ? 'a Wingman note of this kind is not allowed in an empty workspace'
        : 'a tool offer is not allowed in an empty workspace',
    });
  }
  return { falseAlarms, ignored };
}

/** Score one topic's validated judge reply against its key and found evidence. */
export function scoreTopic(prepared: PreparedTopic, raw: RawVerdict, emptyWorkspace: boolean): TopicVerdict {
  return {
    topic: prepared.topic.title,
    emptyWorkspace,
    shouldNote: categoryScore(prepared.noteGold, raw.shouldNote, [...prepared.decisions, ...prepared.todos], [], 'shouldNote'),
    shouldWingman: categoryScore(prepared.wingmanGold.map((moment) => moment.moment), raw.shouldWingman, prepared.wingman, prepared.wingmanBreaches, 'shouldWingman'),
    shouldOfferTool: categoryScore(prepared.toolGold, raw.shouldOfferTool, prepared.offers, prepared.offerBreaches, 'shouldOfferTool'),
    shouldStaySilent: silenceScore(prepared, raw),
    notetaker: {
      decisions: prepared.decisions.length,
      todos: prepared.todos.length,
      minutes: prepared.evidence.minutes?.present === true,
    },
    ignoredWingmanNotes: prepared.ignoredWingman.length,
  };
}

function categoryTotals(scores: readonly CategoryScore[]): CategoryTotals {
  const gold = scores.reduce((sum, score) => sum + score.goldCount, 0);
  const applicable = scores.reduce((sum, score) => sum + score.applicableCount, 0);
  const hits = scores.reduce((sum, score) => sum + score.hits.length, 0);
  const misses = scores.reduce((sum, score) => sum + score.misses.length, 0);
  const notApplicable = scores.reduce((sum, score) => sum + score.notApplicable.length, 0);
  const falseAlarms = scores.reduce((sum, score) => sum + score.falseAlarms.length, 0);
  return { gold, applicable, hits, misses, notApplicable, falseAlarms, recall: applicable === 0 ? null : hits / applicable };
}

/** The plain-number totals across every judged topic. */
export function summarizeVerdicts(verdicts: readonly TopicVerdict[]): Totals {
  return {
    shouldNote: categoryTotals(verdicts.map((verdict) => verdict.shouldNote)),
    shouldWingman: categoryTotals(verdicts.map((verdict) => verdict.shouldWingman)),
    shouldOfferTool: categoryTotals(verdicts.map((verdict) => verdict.shouldOfferTool)),
    shouldStaySilent: { falseAlarms: verdicts.reduce((sum, verdict) => sum + verdict.shouldStaySilent.falseAlarms.length, 0) },
    notetaker: {
      decisions: verdicts.reduce((sum, verdict) => sum + verdict.notetaker.decisions, 0),
      todos: verdicts.reduce((sum, verdict) => sum + verdict.notetaker.todos, 0),
      minutesPresent: verdicts.filter((verdict) => verdict.notetaker.minutes).length,
      topics: verdicts.length,
    },
  };
}

function recallText(recall: number | null): string {
  return recall === null ? 'not scored' : recall.toFixed(2);
}

function categoryLines(name: string, score: CategoryScore): string[] {
  const lines = [`${name}: ${score.hits.length} hit(s), ${score.misses.length} miss(es), ${score.notApplicable.length} not applicable, ${score.falseAlarms.length} false alarm(s) (recall ${recallText(score.recall)})`];
  for (const hit of score.hits) lines.push(`  hit: "${hit.gold}" <- [${hit.foundId}] ${hit.found}`);
  for (const miss of score.misses) lines.push(`  miss: "${miss.gold}" — ${miss.reason}`);
  for (const item of score.notApplicable) lines.push(`  not applicable: "${item.gold}" — ${item.reason}`);
  for (const falseAlarm of score.falseAlarms) {
    lines.push(`  false alarm: [${falseAlarm.id}] ${falseAlarm.text}${falseAlarm.reason === undefined ? '' : ` — ${falseAlarm.reason}`}`);
  }
  return lines;
}

/** The human-readable per-topic block printed by the CLI and kept in the JSON report. */
export function renderVerdict(verdict: TopicVerdict): string[] {
  return [
    `### ${verdict.topic}`,
    '',
    ...categoryLines('shouldNote', verdict.shouldNote),
    ...categoryLines('shouldWingman', verdict.shouldWingman),
    ...categoryLines('shouldOfferTool', verdict.shouldOfferTool),
    `shouldStaySilent: ${verdict.shouldStaySilent.falseAlarms.length} false alarm(s)`,
    ...verdict.shouldStaySilent.falseAlarms.map((entry) => `  false alarm: [${entry.id}] ${entry.text} — ${entry.reason}`),
    ...(verdict.shouldStaySilent.ignored.length === 0 ? [] : [`  ignored inconsistent silence entries: ${verdict.shouldStaySilent.ignored.map((entry) => entry.id).join(', ')}`]),
    `notetaker: ${verdict.notetaker.decisions} decision(s), ${verdict.notetaker.todos} to-do(s), minutes ${verdict.notetaker.minutes ? 'present' : 'missing'}`,
    '',
  ];
}

/** The plain-number totals block. */
export function renderTotals(totals: Totals): string[] {
  const category = (name: string, value: CategoryTotals): string =>
    `${name}: recall ${value.hits}/${value.applicable} = ${recallText(value.recall)} (${value.misses} miss(es), ${value.notApplicable} not applicable, ${value.falseAlarms} false alarm(s))`;
  return [
    '## Totals',
    '',
    category('shouldNote', totals.shouldNote),
    category('shouldWingman', totals.shouldWingman),
    category('shouldOfferTool', totals.shouldOfferTool),
    `shouldStaySilent: ${totals.shouldStaySilent.falseAlarms} false alarm(s)`,
    `notetaker: ${totals.notetaker.decisions} decision(s), ${totals.notetaker.todos} to-do(s), minutes present in ${totals.notetaker.minutesPresent}/${totals.notetaker.topics} topic(s)`,
  ];
}
