/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeState } from '../auth/useMe';
import { SignInPage } from './SignInPage';

const mocks = vi.hoisted(() => ({
  state: { status: 'ready', me: { authEnabled: true, kind: null } } as MeState,
}));

vi.mock('../auth/useMe', () => ({ useMe: () => mocks.state }));

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage(entry = '/signin'): void {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/new" element={<LocationProbe />} />
        <Route path="/workspaces/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mocks.state = { status: 'ready', me: { authEnabled: true, kind: null } };
});

describe('SignInPage', () => {
  it('offers Google sign-in and a practice meeting', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'Sign in with Google' }).getAttribute('href')).toBe(
      '/api/auth/google/start?next=%2Fnew',
    );
    expect(screen.getByRole('link', { name: 'Try a practice meeting' }).getAttribute('href')).toBe(
      '/practice',
    );
  });

  it('carries the page that asked for sign-in into the Google start link', () => {
    renderPage('/signin?next=%2Fworkspaces%2Fws-1');
    expect(screen.getByRole('link', { name: 'Sign in with Google' }).getAttribute('href')).toBe(
      '/api/auth/google/start?next=%2Fworkspaces%2Fws-1',
    );
  });

  it('ignores an external return address', () => {
    renderPage('/signin?next=https%3A%2F%2Fevil.example');
    expect(screen.getByRole('link', { name: 'Sign in with Google' }).getAttribute('href')).toBe(
      '/api/auth/google/start?next=%2Fnew',
    );
  });

  it('sends a signed-in person on to New meeting', () => {
    mocks.state = {
      status: 'ready',
      me: {
        authEnabled: true,
        kind: 'user',
        user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' },
      },
    };
    renderPage('/signin?next=%2Fworkspaces%2Fws-1');
    expect(screen.getByTestId('location').textContent).toBe('/workspaces/ws-1');
  });

  it('shows a plain sign-in error with a retry', () => {
    mocks.state = { status: 'error', message: 'Could not reach the server.' };
    renderPage();
    expect(screen.getByRole('alert').textContent).toContain('Could not reach the server.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
