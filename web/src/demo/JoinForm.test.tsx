/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JoinForm } from './JoinForm';

const roles = [
  { id: 'producer', label: 'Producer' },
  { id: 'marketing_lead', label: 'Marketing Lead' },
];

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof JoinForm>[0]> = {}) {
  const onJoin = vi.fn();
  render(<JoinForm meetingTitle="Launch readiness" roles={roles} onJoin={onJoin} {...props} />);
  return {
    onJoin,
    name: screen.getByLabelText('Your name') as HTMLInputElement,
    role: screen.getByLabelText('Your role') as HTMLSelectElement,
    button: screen.getByRole('button') as HTMLButtonElement,
  };
}

describe('JoinForm', () => {
  it('shows the meeting and offers exactly the roles it was given', () => {
    const { role } = setup();
    expect(screen.getByText('Launch readiness')).toBeTruthy();
    expect([...role.options].map((option) => option.text)).toEqual(['Producer', 'Marketing Lead']);
  });

  it('cannot join without a name', () => {
    const { button, name, onJoin } = setup();
    expect(button.disabled).toBe(true);
    fireEvent.change(name, { target: { value: '   ' } });
    expect(button.disabled).toBe(true);
    fireEvent.submit(button.closest('form')!);
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('joins with the trimmed name and the chosen role label', () => {
    const { button, name, role, onJoin } = setup();
    fireEvent.change(name, { target: { value: '  Josh ' } });
    fireEvent.change(role, { target: { value: 'Marketing Lead' } });
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Josh', 'Marketing Lead', false);
  });

  it('joins with the first role when the person does not change it', () => {
    const { button, name, onJoin } = setup();
    fireEvent.change(name, { target: { value: 'Josh' } });
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Josh', 'Producer', false);
  });

  it('cannot be submitted twice while joining, and shows why a join failed', () => {
    const { button, name, onJoin } = setup({ busy: true, error: 'Microphone blocked' });
    fireEvent.change(name, { target: { value: 'Josh' } });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Joining…');
    fireEvent.submit(button.closest('form')!);
    expect(onJoin).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Microphone blocked');
  });

  it('cannot join when there is no role to take', () => {
    const { button, name } = setup({ roles: [], error: 'No roles' });
    fireEvent.change(name, { target: { value: 'Josh' } });
    expect(button.disabled).toBe(true);
  });

  it('lets a person join without a microphone, to type', () => {
    const { button, name, onJoin } = setup();
    fireEvent.change(name, { target: { value: 'Josh' } });
    fireEvent.click(screen.getByLabelText('Join without a microphone (I will type)'));
    expect(button.textContent).toBe('Join to type');
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Josh', 'Producer', true);
  });
});
