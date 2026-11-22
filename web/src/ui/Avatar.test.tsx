/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar, colourFor, initialsFor } from './Avatar';

afterEach(cleanup);

describe('Avatar', () => {
  it('shows the Google photo when the person has one', () => {
    render(<Avatar name="Ada Lovelace" photoUrl="https://photos.example/ada.jpg" />);

    const image = screen.getByRole('img', { name: 'Ada Lovelace' });
    expect(image.tagName).toBe('IMG');
    expect(image.getAttribute('src')).toBe('https://photos.example/ada.jpg');
  });

  it('falls back to initials on a stable colour', () => {
    const { container } = render(<Avatar name="Ada Lovelace" />);
    const { container: again } = render(<Avatar name="Ada Lovelace" />);

    const circle = container.querySelector('.kaki-avatar');
    const second = again.querySelector('.kaki-avatar');
    expect(circle?.textContent).toBe('AL');
    expect(second?.textContent).toBe('AL');
    expect(circle?.getAttribute('style')).toContain(String(colourFor('Ada Lovelace')));
    expect(second?.getAttribute('style')).toBe(circle?.getAttribute('style'));
  });

  it('gives one-word names and blank names sensible initials', () => {
    expect(initialsFor('Ada')).toBe('AD');
    expect(initialsFor('  ')).toBe('?');
  });
});
