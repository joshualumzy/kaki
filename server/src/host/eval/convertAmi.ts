import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ReplayLine } from '../replay';

export const AMI_MEETINGS = ['ES2008a', 'ES2013b', 'IS1005c', 'IS1008d'] as const;

const RAW_DIR = fileURLToPath(new URL('../../../../planning/ami-raw/', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('../../../../scenarios/ami-eval/meetings/', import.meta.url));
const AGENTS = ['A', 'B', 'C', 'D'] as const;
const ROLE_LABELS: Record<string, string> = {
  PM: 'Project Manager',
  ME: 'Marketing Expert',
  UI: 'User Interface Designer',
  ID: 'Industrial Designer',
};

export interface AmiWord {
  agent: string;
  start: number;
  end: number;
  text: string;
  order: number;
}

export interface AmiGold {
  actions: string[];
  decisions: string[];
  problems: string[];
}

export interface AmiFixture {
  meeting: string;
  source: string;
  lines: ReplayLine[];
  gold: AmiGold;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
  return match?.[1];
}

function optionalTime(attributes: string, name: string, where: string): number | undefined {
  const raw = attribute(attributes, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${where} has an invalid "${name}"`);
  return value;
}

export function parseWordsXml(xml: string, agent: string): AmiWord[] {
  const words: AmiWord[] = [];
  let order = 0;
  let seen = 0;
  let lastEnd = 0;
  for (const match of xml.matchAll(/<w\b([^>]*)>([\s\S]*?)<\/w>/g)) {
    seen += 1;
    const attributes = match[1] ?? '';
    const text = decodeXmlEntities(match[2] ?? '').trim();
    const where = `word ${seen} in ${agent}`;
    const start = optionalTime(attributes, 'starttime', where) ?? lastEnd;
    const end = optionalTime(attributes, 'endtime', where) ?? start;
    lastEnd = Math.max(lastEnd, end);
    if (text.length === 0) continue;
    if (attribute(attributes, 'punc') === 'true') {
      const previous = words.at(-1);
      if (previous !== undefined) {
        previous.text += text;
        previous.end = Math.max(previous.end, end);
      }
      continue;
    }
    words.push({ agent, start, end, text, order });
    order += 1;
  }
  return words;
}

function appendToken(text: string, token: string): string {
  return text.length === 0 ? token : `${text} ${token}`;
}

/**
 * Build each speaker's utterances on their own (a new one after a pause longer than `pauseSeconds`), then order
 * all utterances by start time. Grouping per speaker first keeps a sentence whole when someone talks over it.
 */
export function mergeTurns(
  words: AmiWord[],
  speakerFor: (agent: string) => string,
  pauseSeconds = 2,
): ReplayLine[] {
  if (words.length === 0) return [];
  const origin = Math.min(...words.map((word) => word.start));
  const utterances: Array<{ start: number; agent: string; speaker: string; text: string }> = [];
  for (const agent of [...new Set(words.map((word) => word.agent))].sort()) {
    const own = words
      .filter((word) => word.agent === agent)
      .sort((left, right) => left.start - right.start || left.order - right.order);
    let current: { start: number; agent: string; speaker: string; text: string } | undefined;
    let end = 0;
    for (const word of own) {
      if (current === undefined || word.start - end > pauseSeconds) {
        current = { start: word.start, agent, speaker: speakerFor(agent), text: word.text };
        utterances.push(current);
      } else {
        current.text = appendToken(current.text, word.text);
      }
      end = Math.max(end, word.end);
    }
  }
  utterances.sort((left, right) => left.start - right.start || left.agent.localeCompare(right.agent));
  return utterances.map((utterance) => ({
    at: Math.round((utterance.start - origin) * 1000) / 1000,
    speaker: utterance.speaker,
    text: utterance.text,
  }));
}

export function parseAbstractiveXml(xml: string): AmiGold {
  const section = (name: string): string[] => {
    const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(xml);
    if (match === null) return [];
    return [...(match[1] ?? '').matchAll(/<sentence\b[^>]*>([\s\S]*?)<\/sentence>/g)]
      .map((sentence) => decodeXmlEntities(sentence[1] ?? '').replace(/\s+/g, ' ').trim())
      .filter((sentence) => sentence.length > 0);
  };
  return { actions: section('actions'), decisions: section('decisions'), problems: section('problems') };
}

export function parseMeetingsXml(xml: string): Map<string, Map<string, string>> {
  const meetings = new Map<string, Map<string, string>>();
  for (const match of xml.matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g)) {
    const observation = attribute(match[1] ?? '', 'observation');
    if (observation === undefined) continue;
    const speakers = new Map<string, string>();
    for (const speaker of (match[2] ?? '').matchAll(/<speaker\b([^>]*)>/g)) {
      const attributes = speaker[1] ?? '';
      const agent = attribute(attributes, 'nxt_agent');
      const role = attribute(attributes, 'role');
      if (agent !== undefined && role !== undefined) speakers.set(agent, role);
    }
    meetings.set(observation, speakers);
  }
  return meetings;
}

function speakerForMeeting(speakers: Map<string, string> | undefined, meeting: string) {
  return (agent: string): string => {
    const code = speakers?.get(agent);
    if (code === undefined) throw new Error(`Meeting ${meeting} has no speaker for agent ${agent}`);
    const label = ROLE_LABELS[code];
    if (label === undefined) throw new Error(`Meeting ${meeting} agent ${agent} has unknown role "${code}"`);
    return label;
  };
}

export async function convertMeeting(meeting: string, rawDir = RAW_DIR, outDir = OUT_DIR): Promise<AmiFixture> {
  const meetings = parseMeetingsXml(await readFile(path.join(rawDir, 'meetings.xml'), 'latin1'));
  const speakers = meetings.get(meeting);
  if (speakers === undefined) throw new Error(`meetings.xml has no meeting ${meeting}`);

  const words: AmiWord[] = [];
  for (const agent of AGENTS) {
    const file = path.join(rawDir, 'words', `${meeting}.${agent}.words.xml`);
    words.push(...parseWordsXml(await readFile(file, 'latin1'), agent));
  }

  const lines = mergeTurns(words, speakerForMeeting(speakers, meeting));
  const gold = parseAbstractiveXml(await readFile(path.join(rawDir, 'abstractive', `${meeting}.abssumm.xml`), 'latin1'));
  const fixture: AmiFixture = { meeting, source: 'AMI Meeting Corpus, CC BY 4.0', lines, gold };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `${meeting}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  return fixture;
}

async function main(): Promise<void> {
  for (const meeting of AMI_MEETINGS) {
    const fixture = await convertMeeting(meeting);
    console.log(
      `${meeting}: ${fixture.lines.length} lines, ${fixture.gold.actions.length} actions, ` +
        `${fixture.gold.decisions.length} decisions, ${fixture.gold.problems.length} problems`,
    );
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
