/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./room/Meeting', () => ({
  default: ({ variant, initialCode }: { variant?: string; initialCode?: string }) => (
    <p>{`${variant ?? 'practice'}:${initialCode ?? ''}`}</p>
  ),
}));

import { ParticipantJoinPage } from './ParticipantJoinPage';

afterEach(cleanup);

describe('ParticipantJoinPage', () => {
  it('pre-fills the code from the invite link', () => {
    render(
      <MemoryRouter initialEntries={['/join?code=K7QX']}>
        <Routes>
          <Route path="/join" element={<ParticipantJoinPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('participant:K7QX')).toBeTruthy();
  });
});
