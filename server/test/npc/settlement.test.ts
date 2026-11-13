import { describe, expect, it, vi } from 'vitest';
import type { SuggestInput } from '@kaki/shared';
import { postSettledTopic } from '../../src/npc/settlement';

const followUp: SuggestInput = {
  title: 'Post the prep plan', context: 'Visitor decision: use fresh stock',
  suggestedAssignee: 'chef', actionKind: 'mattermost_post',
  agendaItemTitle: 'Prep', decisionSource: 'use fresh stock',
};

describe('postSettledTopic', () => {
  it('retries one rejected POST and succeeds', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const log = vi.fn();
    await postSettledTopic(fetcher, 'http://localhost/dev/settle-topic', followUp, log);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
  });

  it('rejects visibly after two failed POSTs so Lock can reopen', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('connection refused'));
    const log = vi.fn();
    await expect(postSettledTopic(fetcher, 'http://localhost/dev/settle-topic', followUp, log))
      .rejects.toThrow('connection refused');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ERROR'));
  });
});
