/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeState } from '../auth/useMe';
import { LandingPage } from './LandingPage';

const mocks = vi.hoisted(() => ({
  state: { status: 'ready', me: { authEnabled: false } } as MeState,
  find: vi.fn(),
}));

vi.mock('../auth/useMe', () => ({ useMe: () => mocks.state }));
vi.mock('../product/api', () => ({ findMeetingByCode: mocks.find }));

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/m/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  mocks.state = { status: 'ready', me: { authEnabled: false } };
});

describe('LandingPage', () => {
  it('sends a signed-out visitor through Google sign-in, then to a new meeting', () => {
    mocks.state = { status: 'ready', me: { authEnabled: true, kind: null } };
    renderPage();
    expect(screen.getByRole('link', { name: 'Run a team meeting' }).getAttribute('href')).toBe(
      '/signin?next=/new',
    );
  });

  it('links to the practice meeting', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'Try a practice meeting' }).getAttribute('href')).toBe('/practice');
  });

  it('links to Privacy and Terms in the footer', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/privacy');
    expect(screen.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('/terms');
  });

  it('shows a six-character example meeting code', () => {
    renderPage();
    const input = screen.getByLabelText('Got an invite? Enter the meeting code') as HTMLInputElement;
    expect(input.placeholder).toBe('K7M2Q9');
    expect(input.placeholder).toHaveLength(6);
  });

  it('takes an invite code to that meeting\'s join page', async () => {
    mocks.find.mockResolvedValue('mtg-1');
    renderPage();
    fireEvent.change(screen.getByLabelText('Got an invite? Enter the meeting code'), {
      target: { value: 'k7qx' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect((await screen.findByTestId('location')).textContent).toBe('/m/mtg-1?code=K7QX');
    expect(mocks.find).toHaveBeenCalledWith('K7QX');
  });

  it('says plainly when no meeting has that code', async () => {
    mocks.find.mockRejectedValue(new Error('We couldn\'t find a meeting with that code.'));
    renderPage();
    fireEvent.change(screen.getByLabelText('Got an invite? Enter the meeting code'), {
      target: { value: 'zzzzzz' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect((await screen.findByRole('alert')).textContent).toContain("couldn't find a meeting");
  });

  it('shows a plain sign-in error with a retry, never a bare spinner', () => {
    mocks.state = { status: 'error', message: 'Could not reach the server.' };
    renderPage();
    expect(screen.getByRole('alert').textContent).toContain('Could not reach the server.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
