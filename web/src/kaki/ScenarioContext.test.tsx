/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';

const scenario: Scenario = {
  id: 'scenario-context-test',
  organisation: 'Test Kopitiam',
  meetingTitle: 'Lunch service',
  roles: [{ id: 'chef', label: 'Chef' }],
  attendees: [],
  agenda: [{ title: 'Prep', minutes: 5, canWait: false, deadline: 'before service', ownerRole: 'chef' }],
};

let ScenarioProvider: typeof import('./ScenarioContext').ScenarioProvider;

function okResponse(): Response {
  return { ok: true, status: 200, json: async () => scenario } as unknown as Response;
}

function statusResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

function renderProvider(): void {
  render(
    <ScenarioProvider>
      <p>Meeting ready</p>
    </ScenarioProvider>,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  ({ ScenarioProvider } = await import('./ScenarioContext'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ScenarioProvider', () => {
  it('keeps loading while the server is starting, then shows the app', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(502))
      .mockResolvedValueOnce(statusResponse(502))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderProvider();
    expect(screen.getByText('Loading scenario…')).toBeTruthy();

    await flush();
    expect(screen.getByText('Starting up… this can take a few seconds.')).toBeTruthy();
    expect(screen.queryByText('Meeting ready')).toBeNull();

    await advance(1_000);
    expect(screen.getByText('Starting up… this can take a few seconds.')).toBeTruthy();

    await advance(1_000);
    expect(screen.getByText('Meeting ready')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails at once on a status that is not the server starting', async () => {
    const fetchMock = vi.fn().mockResolvedValue(statusResponse(404));
    vi.stubGlobal('fetch', fetchMock);

    renderProvider();
    await flush();

    expect(screen.getByText('Could not load the scenario')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('GET /api/scenario failed (404)');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();

    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after 90 s of 502s, and Try again can succeed', async () => {
    let failing = true;
    const fetchMock = vi.fn(async () => (failing ? statusResponse(502) : okResponse()));
    vi.stubGlobal('fetch', fetchMock);

    renderProvider();
    await flush();
    expect(screen.getByText('Starting up… this can take a few seconds.')).toBeTruthy();

    await advance(89_000);
    expect(screen.getByText('Starting up… this can take a few seconds.')).toBeTruthy();
    expect(screen.queryByText('Could not load the scenario')).toBeNull();

    await advance(1_000);
    expect(screen.getByText('Could not load the scenario')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('GET /api/scenario failed (502)');
    const callsAtGiveUp = fetchMock.mock.calls.length;

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Loading scenario…')).toBeTruthy();

    await flush();
    expect(screen.getByText('Meeting ready')).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBe(callsAtGiveUp + 1);
  });
});
