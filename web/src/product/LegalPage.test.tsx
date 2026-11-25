/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { PrivacyPage, TermsPage } from './LegalPage';

function renderPage(page: 'privacy' | 'terms'): void {
  render(
    <MemoryRouter initialEntries={[`/${page}`]}>
      {page === 'privacy' ? <PrivacyPage /> : <TermsPage />}
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('PrivacyPage', () => {
  it('sets the tab title and describes what the code does', () => {
    renderPage('privacy');
    expect(document.title).toBe('Privacy · Kaki');
    expect(screen.getByRole('heading', { name: 'Privacy', level: 1 })).toBeTruthy();
    expect(screen.getByText(/Google sign-in only/)).toBeTruthy();
    expect(screen.getAllByText(/Azure Speech/).length).toBeGreaterThan(0);
    expect(screen.getByText(/does not record or keep/)).toBeTruthy();
    expect(screen.getByText(/can contain meeting text/)).toBeTruthy();
    expect(screen.getByText(/keeps logs for up to 30 days/)).toBeTruthy();
    expect(screen.getByText(/backs up its database every night/)).toBeTruthy();
    expect(screen.getByText(/keeps the newest 7/)).toBeTruthy();
    expect(screen.getByText(/in backups for up to 7 days/)).toBeTruthy();
  });

  it('keeps the contact placeholders and no coursework wording', () => {
    renderPage('privacy');
    expect(screen.getByText('joshua.lum@u.nus.edu', { exact: false })).toBeTruthy();
    expect(screen.getByText('xiao_xiao@u.nus.edu', { exact: false })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/student project|coursework|IT5007/i);
  });
});

describe('TermsPage', () => {
  it('sets the tab title and explains approval and AI limits', () => {
    renderPage('terms');
    expect(document.title).toBe('Terms · Kaki');
    expect(screen.getByRole('heading', { name: 'Terms', level: 1 })).toBeTruthy();
    expect(screen.getByText(/reviews and approves every draft/)).toBeTruthy();
    expect(screen.getByText(/can be wrong or incomplete/)).toBeTruthy();
  });

  it('keeps the contact placeholders and no coursework wording', () => {
    renderPage('terms');
    expect(screen.getByText('joshua.lum@u.nus.edu', { exact: false })).toBeTruthy();
    expect(screen.getByText('xiao_xiao@u.nus.edu', { exact: false })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/student project|coursework|IT5007/i);
  });
});
