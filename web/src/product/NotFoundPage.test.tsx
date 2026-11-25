/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundPage } from './NotFoundPage';

afterEach(() => {
  cleanup();
});

describe('NotFoundPage', () => {
  it('says plainly that the page does not exist and offers the way home', () => {
    render(
      <MemoryRouter initialEntries={['/no-such-page']}>
        <NotFoundPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.getByText(/This page does not exist/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Kaki' }).getAttribute('href')).toBe('/');
    expect(document.title).toBe('Page not found · Kaki');
  });
});
