import { describe, expect, it } from 'vitest';
import { createFakeLlm } from '../../src/services/llm';
import {
  askTellKaki,
  parseTellKakiReply,
  TELL_KAKI_REPLY_MESSAGE,
  TELL_KAKI_SCHEMA,
  TellKakiReplyError,
} from '../../src/host/tellKaki';

describe('Tell Kaki', () => {
  it('reads a reply, trims titles and omits a null duration', () => {
    const reply = parseTellKakiReply(
      '```json\n{"title":"  Opening review  ","agenda":[{"title":"  Budget  ","minutes":15},{"title":"Hiring","minutes":null}]}\n```',
    );

    expect(reply).toEqual({
      title: 'Opening review',
      agenda: [{ title: 'Budget', minutes: 15 }, { title: 'Hiring' }],
    });
  });

  it('allows a null title and an empty agenda', () => {
    expect(parseTellKakiReply('{"title":null,"agenda":[]}')).toEqual({ title: null, agenda: [] });
  });

  it.each([
    ['not json', 'not json'],
    ['missing agenda', '{"title":"Budget"}'],
    ['an extra root key', '{"title":"Budget","agenda":[],"owner":"Ada"}'],
    ['an empty title', '{"title":"  ","agenda":[]}'],
    ['an item owner', '{"title":"Budget","agenda":[{"title":"Budget","minutes":5,"owner":"Ada"}]}'],
    ['a zero duration', '{"title":"Budget","agenda":[{"title":"Budget","minutes":0}]}'],
    ['an overlong duration', '{"title":"Budget","agenda":[{"title":"Budget","minutes":241}]}'],
  ])('rejects %s', (_label, content) => {
    expect(() => parseTellKakiReply(content)).toThrow(TellKakiReplyError);
    expect(() => parseTellKakiReply(content)).toThrow(TELL_KAKI_REPLY_MESSAGE);
  });

  it('asks the model for the strict reply shape and keeps the person text intact', async () => {
    const llm = createFakeLlm(() => '{"title":"Budget","agenda":[]}');

    await askTellKaki(llm, '  Budget and hiring  ');

    expect(llm.callOptions[0]).toEqual({ json: true, schema: TELL_KAKI_SCHEMA });
    expect(llm.calls[0]?.[0]?.role).toBe('system');
    expect(llm.calls[0]?.[1]).toEqual({ role: 'user', content: '  Budget and hiring  ' });
    expect(llm.calls[0]?.[0]?.content).toContain('Never add');
    expect(llm.calls[0]?.[0]?.content).toContain('minutes only');
  });
});
