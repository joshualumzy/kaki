/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

afterEach(cleanup);

describe('Markdown', () => {
  it('renders headings, lists and bold text instead of raw markers', () => {
    render(
      <Markdown
        text={'## Action Items\n\n- **Fix the oven** — Chef\n- Chase the receipt\n\n**Date:** 2026-11-03'}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Action Items' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Fix the oven').tagName).toBe('STRONG');
    expect(screen.queryByText(/##/)).toBeNull();
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it('turns safe links into links and never injects raw HTML', () => {
    const { container } = render(
      <Markdown text={'[Wiki](https://wiki.test/page)\n\n<script>alert(1)</script>'} />,
    );

    const link = screen.getByRole('link', { name: 'Wiki' });
    expect(link.getAttribute('href')).toBe('https://wiki.test/page');
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText(/<script>alert/)).toBeTruthy();
  });
});
