import { describe, expect, it } from 'vitest';
import { TOPIC_EARLIER_LINES, TOPIC_RECENT_LINES, TopicRecord } from '../../src/npc/topicRecord';

describe('topic record', () => {
  it('keeps the whole topic but caps the prompt at the latest lines plus clipped older ones', () => {
    const record = new TopicRecord();
    record.start('Prep');
    for (let index = 0; index < 40; index += 1) {
      record.said({ speaker: 'Ada', text: `Point number ${index} with quite a few more words to clip here` });
    }
    const view = record.promptView();
    expect(view.recent).toHaveLength(TOPIC_RECENT_LINES);
    expect(view.recent.at(-1)?.text).toContain('Point number 39');
    expect(view.earlier).toHaveLength(TOPIC_EARLIER_LINES);
    expect(view.earlier.at(-1)?.text).not.toContain('here');
  });

  it('forgets the last topic and its open question when a new one starts', () => {
    const record = new TopicRecord();
    record.start('Prep');
    record.said({ speaker: 'Ada', text: 'Thirty trays only cover thirty platters.' });
    record.ask({ from: 'Ada', to: 'Josh', text: 'Who covers the counter?' });
    record.start('Service');
    expect(record.promptView()).toEqual({ earlier: [], recent: [] });
    expect(record.openQuestion).toBeUndefined();
  });
});
