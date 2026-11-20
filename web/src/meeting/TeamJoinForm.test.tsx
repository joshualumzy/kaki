/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamJoinForm } from './TeamJoinForm';

vi.mock('../demo/MediaPreview', () => ({ MediaPreview: () => null }));

const roles = [
  { id: 'producer', label: 'Producer' },
  { id: 'marketing_lead', label: 'Marketing Lead' },
];

afterEach(cleanup);

describe('TeamJoinForm', () => {
  it('offers exactly the person seats and pre-fills the invite code', () => {
    render(
      <TeamJoinForm meetingTitle="Launch readiness" roles={roles} initialCode="ABCD" onJoin={vi.fn()} />,
    );

    expect((screen.getByLabelText('Your seat') as HTMLSelectElement).options).toHaveLength(2);
    expect((screen.getByLabelText('Meeting code') as HTMLInputElement).value).toBe('ABCD');
    expect(screen.queryByText(/Kopitiam/)).toBeNull();
    expect(screen.queryByText(/How to play/)).toBeNull();
  });

  it('sends the name, seat, media choice and code', () => {
    const onJoin = vi.fn();
    render(
      <TeamJoinForm meetingTitle="Launch readiness" roles={roles} initialCode="ABCD" onJoin={onJoin} />,
    );

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: ' Josh ' } });
    fireEvent.change(screen.getByLabelText('Your seat'), { target: { value: 'marketing_lead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    expect(onJoin).toHaveBeenCalledWith('Josh', 'marketing_lead', { microphone: true, camera: false }, 'ABCD');
  });

  it('gives the owner no code box', () => {
    render(<TeamJoinForm meetingTitle="Launch readiness" roles={roles} owner onJoin={vi.fn()} />);
    expect(screen.queryByLabelText('Meeting code')).toBeNull();
    expect(screen.getByRole('button', { name: 'Join the meeting room' })).toBeTruthy();
  });

  it('shows the server error in plain words', () => {
    render(
      <TeamJoinForm
        meetingTitle="Launch readiness"
        roles={roles}
        error="This meeting has ended; the meeting owner must start the next one."
        onJoin={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('This meeting has ended');
  });
});
