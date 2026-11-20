/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeState } from '../auth/useMe';
import { LandingPage } from './LandingPage';

const mocks = vi.hoisted(() => ({
  state: { status: 'ready', me: { authEnabled: false } } as MeState,
}));

vi.mock('../auth/useMe', () => ({ useMe: () => mocks.state }));

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/join" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mocks.state = { status: 'ready', me: { authEnabled: false } };
});

describe('LandingPage', () => {
  it('sends the owner to setup when sign-in is off', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'Run a team meeting' }).getAttribute('href')).toBe('/setup');
  });

  it('sends a signed-out visitor through sign-in, back to setup', () => {
    mocks.state = { status: 'ready', me: { authEnabled: true, kind: null } };
    renderPage();
    expect(screen.getByRole('link', { name: 'Run a team meeting' }).getAttribute('href')).toBe(
      '/login?return=/setup',
    );
  });

  it('links to the practice meeting', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'Try a practice meeting' }).getAttribute('href')).toBe('/practice');
  });

  it('takes an invite code to the participant join page', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Got an invite? Enter the meeting code'), {
      target: { value: 'k7qx' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(screen.getByTestId('location').textContent).toBe('/join?code=K7QX');
  });

  it('shows a plain sign-in error with a retry, never a bare spinner', () => {
    mocks.state = { status: 'error', message: 'Could not reach the server.' };
    renderPage();
    expect(screen.getByRole('alert').textContent).toContain('Could not reach the server.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
