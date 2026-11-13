import type { SuggestInput } from '@kaki/shared';

/** Send a settlement once, then retry once if the server rejects it or the connection fails. */
export async function postSettledTopic(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  followUp: SuggestInput,
  log: (message: string) => void,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetcher(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(followUp),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return;
    } catch (error) {
      log(`ERROR: follow-up POST for "${followUp.agendaItemTitle}" failed (${attempt}/2): ${String(error)}`);
      if (attempt === 2) throw error;
    }
  }
}
