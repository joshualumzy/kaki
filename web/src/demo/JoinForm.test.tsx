/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinForm } from './JoinForm';

const roles = [
  { id: 'producer', label: 'Producer' },
  { id: 'marketing_lead', label: 'Marketing Lead' },
];

class FakeContext {
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData() {} };
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  async close() {}
}

beforeEach(() => {
  const stream = { getTracks: () => [{ stop() {} }] };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => stream } });
  vi.stubGlobal('AudioContext', FakeContext);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(props: Partial<Parameters<typeof JoinForm>[0]> = {}) {
  const onJoin = vi.fn();
  render(<JoinForm meetingTitle="Launch readiness" roles={roles} onJoin={onJoin} {...props} />);
  return {
    onJoin,
    name: screen.getByLabelText('Your name') as HTMLInputElement,
    role: screen.getByLabelText('Your role') as HTMLSelectElement,
    button: screen.getByRole('button', { name: /^(Join|Joining)/ }) as HTMLButtonElement,
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
    fireEvent.change(name, { target: { value: '' } });
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
    expect(onJoin).toHaveBeenCalledWith('Josh', 'Marketing Lead', { microphone: true, camera: false });
  });

  it('joins with the first role when the person does not change it', () => {
    const { button, name, onJoin } = setup();
    fireEvent.change(name, { target: { value: 'Josh' } });
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Josh', 'Producer', { microphone: true, camera: false });
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

  it('starts with a default name the person can change, not a real person\'s', () => {
    const { name } = setup();
    expect(name.value).toBe('Foo');
  });

  it('toggles the microphone and camera like a call, and joins with the choice', () => {
    const { button, onJoin } = setup();
    const mic = screen.getByLabelText('Microphone');
    const camera = screen.getByLabelText('Camera');
    expect(mic.getAttribute('aria-pressed')).toBe('true');
    expect(camera.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(mic);
    expect(button.textContent).toBe('Join to type');
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Foo', 'Producer', { microphone: false, camera: false });
  });

  it('has no code box until a code is needed or came with the link', () => {
    setup();
    expect(screen.queryByLabelText('Meeting code')).toBeNull();
  });

  it('requires the code once it is asked for, and sends it', () => {
    const { button, onJoin } = setup({ askCode: true });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Meeting code'), { target: { value: 'k7qx' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Foo', 'Producer', { microphone: true, camera: false }, 'K7QX');
  });

  it('fills the code from the link but does not insist on it', () => {
    const { onJoin, button } = setup({ initialCode: 'ABCD' });
    expect((screen.getByLabelText('Meeting code') as HTMLInputElement).value).toBe('ABCD');
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Foo', 'Producer', { microphone: true, camera: false }, 'ABCD');
  });
});
