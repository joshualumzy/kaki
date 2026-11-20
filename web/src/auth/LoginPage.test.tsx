/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeState } from './useMe';
import { LoginPage } from './LoginPage';

const mocks = vi.hoisted(() => ({
  state: { status: 'ready', me: { authEnabled: true, kind: null } } as MeState,
  signIn: vi.fn(async () => ({ ok: true })),
}));

vi.mock('./useMe', () => ({ useMe: () => mocks.state }));
vi.mock('./api', () => ({ signIn: mocks.signIn }));

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage(entry: string): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<LocationProbe />} />
        <Route path="/meeting" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mocks.state = { status: 'ready', me: { authEnabled: true, kind: null } };
  mocks.signIn.mockClear();
});

describe('LoginPage', () => {
  it('returns to setup after signing in from setup', async () => {
    renderPage('/login?return=/setup');

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'demo@kaki.demo' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/setup'));
  });

  it('keeps the owner meeting room as the default destination', () => {
    mocks.state = { status: 'ready', me: { authEnabled: true, kind: 'host' } };
    renderPage('/login');
    expect(screen.getByTestId('location').textContent).toBe('/meeting');
  });

  it('falls back to the owner meeting room for a malformed return path', async () => {
    renderPage('/login?return=%2F%5Cevil.com');

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'demo@kaki.demo' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/meeting'));
  });
});
