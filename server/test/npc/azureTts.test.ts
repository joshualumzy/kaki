import { describe, expect, it } from 'vitest';
import { buildSsml, parseVoiceSpec } from '../../src/npc/azureTts';

describe('voice specs', () => {
  it('reads a bare voice name', () => {
    expect(parseVoiceSpec('en-SG-LunaNeural')).toEqual({ voice: 'en-SG-LunaNeural' });
  });

  it('reads pitch, rate and lang', () => {
    expect(parseVoiceSpec('zh-CN-Bo:MAI-Voice-2.1?lang=en-US&rate=-4%')).toEqual({
      voice: 'zh-CN-Bo:MAI-Voice-2.1',
      rate: '-4%',
      lang: 'en-US',
    });
    expect(parseVoiceSpec('en-SG-WayneNeural?pitch=+5%')).toEqual({ voice: 'en-SG-WayneNeural', pitch: '+5%' });
  });

  it('rejects an unknown setting instead of ignoring it', () => {
    expect(() => parseVoiceSpec('en-SG-LunaNeural?speed=-8%')).toThrow(/unknown setting "speed"/);
  });
});

describe('SSML', () => {
  it("uses the voice's own locale when no language is given", () => {
    expect(buildSsml({ voice: 'en-IN-ArjunNeural', rate: '-8%' }, 'Not tested, not live.')).toBe(
      "<speak version='1.0' xml:lang='en-IN'><voice name='en-IN-ArjunNeural'><prosody rate='-8%'>Not tested, not live.</prosody></voice></speak>",
    );
  });

  it('tells a voice from another language that the text is in `lang`', () => {
    expect(buildSsml({ voice: 'zh-CN-Bo:MAI-Voice-2.1', lang: 'en-US' }, "Okay, let's keep this tight.")).toBe(
      "<speak version='1.0' xml:lang='en-US'><voice name='zh-CN-Bo:MAI-Voice-2.1'><lang xml:lang='en-US'>Okay, let&apos;s keep this tight.</lang></voice></speak>",
    );
  });
});
