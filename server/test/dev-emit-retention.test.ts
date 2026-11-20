import { afterEach, describe, expect, it } from 'vitest';
import { connectClient, createTestApp, portOf, settle } from './helpers';

describe('/dev/emit retention', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  afterEach(() => app.close());

  async function emit(event: unknown): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${portOf(app)}/dev/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    expect(response.status).toBe(200);
  }

  it('keeps demo events for late joiners but never replays transcript lines', async () => {
    app = await createTestApp({ devRoutes: true });
    await emit({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: { speaker: 'Ada (Chef)', text: 'Good morning everyone', timestamp: new Date().toISOString() },
    });
    await emit({
      type: 'TRANSCRIPT_LINE_UPDATED',
      audience: { kind: 'all' },
      payload: { lineId: 'line-1', speaker: 'Ada (Chef)', text: 'Good morning', timestamp: new Date().toISOString(), cut: true },
    });
    await emit({
      type: 'HOST_SPEECH_TRIGGERED',
      audience: { kind: 'screen' },
      payload: { kind: 'OPENING', text: 'Welcome.' },
    });

    const late = await connectClient(portOf(app), 'screen');
    await settle();
    const types = late.messages.map((message) => message.type);
    late.close();

    expect(types).toContain('HOST_SPEECH_TRIGGERED');
    expect(types).not.toContain('TRANSCRIPT_CHUNK');
    expect(types).not.toContain('TRANSCRIPT_LINE_UPDATED');
  });
});
