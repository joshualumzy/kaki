/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinForm } from './JoinForm';

const roles = [
  { id: 'operations_director', label: 'Producer' },
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
  it('preloads the art supplied by selected agenda items', () => {
    const loaded: string[] = [];
    vi.stubGlobal('Image', class { set src(value: string) { loaded.push(value); } });
    setup({ agenda: [{ title: 'Current', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'operations_director', art: '/scenario/current.svg' }] });
    expect(loaded).toContain('/scenario/current.svg');
  });

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

  it('joins with the trimmed name and the chosen role id, while showing labels', () => {
    const { button, name, role, onJoin } = setup();
    fireEvent.change(name, { target: { value: '  Josh ' } });
    expect([...role.options].map((option) => option.value)).toEqual(['operations_director', 'marketing_lead']);
    fireEvent.change(role, { target: { value: 'marketing_lead' } });
    fireEvent.click(screen.getByLabelText('Microphone'));
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Josh', 'marketing_lead', { microphone: true, camera: false });
  });

  it('joins with the first role when the person does not change it', () => {
    const { button, name, onJoin } = setup();
    fireEvent.change(name, { target: { value: 'Josh' } });
    fireEvent.click(screen.getByLabelText('Microphone'));
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Josh', 'operations_director', { microphone: true, camera: false });
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

  it('starts with an empty name box so the person fills in their own name', () => {
    const { name, button } = setup();
    expect(name.value).toBe('');
    expect(button.disabled).toBe(true);
  });

  it('starts with the microphone off and asks for it only after a tap', () => {
    const { button, name, onJoin } = setup();
    const mic = screen.getByLabelText('Microphone');
    const camera = screen.getByLabelText('Camera');
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    expect(camera.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent).toBe('Join with mic off');

    fireEvent.change(name, { target: { value: 'Josh' } });
    fireEvent.click(mic);
    expect(button.textContent).toBe('Join with mic');
    fireEvent.click(mic);
    expect(button.textContent).toBe('Join with mic off');
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Josh', 'operations_director', { microphone: false, camera: false });
  });

  it('has no code box until a code is needed or came with the link', () => {
    setup();
    expect(screen.queryByLabelText('Meeting code')).toBeNull();
  });

  it('requires the code once it is asked for, and sends it', () => {
    const { button, name, onJoin } = setup({ askCode: true });
    fireEvent.change(name, { target: { value: 'Josh' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Meeting code'), { target: { value: 'k7qx' } });
    fireEvent.click(screen.getByLabelText('Microphone'));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Josh', 'operations_director', { microphone: true, camera: false }, 'K7QX');
  });

  it('fills the code from the link but does not insist on it', () => {
    const { onJoin, name, button } = setup({ initialCode: 'ABCD' });
    fireEvent.change(name, { target: { value: 'Josh' } });
    expect((screen.getByLabelText('Meeting code') as HTMLInputElement).value).toBe('ABCD');
    fireEvent.click(screen.getByLabelText('Microphone'));
    fireEvent.click(button);
    expect(onJoin).toHaveBeenCalledWith('Josh', 'operations_director', { microphone: true, camera: false }, 'ABCD');
  });
});
