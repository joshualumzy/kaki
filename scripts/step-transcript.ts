import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';

const port = process.env.PORT ?? '3001';
const folder = process.env.SCENARIO ?? 'pixel-kampung';
const scenariosDir = fileURLToPath(new URL('../scenarios/', import.meta.url));

async function readJson(file: string): Promise<any> {
  const text = await readFile(file, 'utf8');
  return JSON.parse(text);
}

async function post(pathname: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function promptEnter(message: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

const scenarioDir = path.join(scenariosDir, folder);
const replay = await readJson(path.join(scenarioDir, 'replay', 'transcript.json'));
const lines = replay.lines as any[];

console.log(`Loaded ${lines.length} lines from transcript.json`);
console.log(`Press Enter to inject the next line into the live meeting...`);

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  await promptEnter(`\n[${line.speaker}]: ${line.text}\nPress Enter to send -> `);
  
  const event = {
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'screen' },
    payload: { 
      speaker: line.speaker, 
      text: line.text, 
      timestamp: new Date().toISOString() 
    }
  };
  
  const response = await post('/dev/emit', event);
  if (!response.ok) {
    console.error(`Failed to send line: ${response.status} ${await response.text()}`);
  }
}

console.log(`\nFinished sending all lines!`);
