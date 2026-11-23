/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppBar } from './AppBar';

const mocks = vi.hoisted(() => ({
  logout: vi.fn(),
  deleteAccount: vi.fn(),
}));

vi.mock('./api', () => ({
  logout: mocks.logout,
  deleteAccount: mocks.deleteAccount,
}));

const user = { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' };

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderBar(): void {
  render(
    <MemoryRouter initialEntries={['/workspaces/ws-1']}>
      <Routes>
        <Route path="/workspaces/ws-1" element={<AppBar user={user} workspaces={[]} />} />
        <Route path="/signin" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function openDeleteDialog(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete account' }));
}

beforeEach(() => {
  mocks.logout.mockReset();
  mocks.deleteAccount.mockReset();
  mocks.logout.mockResolvedValue(undefined);
  mocks.deleteAccount.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe('AppBar delete account', () => {
  it('opens the confirmation dialog from the account menu', () => {
    renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Ada Lovelace' }));

    expect(screen.getByRole('menuitem', { name: 'Delete account' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete account' }));

    expect(screen.getByRole('dialog', { name: 'Delete your account' })).toBeTruthy();
  });

  it('keeps the delete button disabled until the confirmation reads DELETE', () => {
    renderBar();
    openDeleteDialog();

    const deleteButton = screen.getByRole('button', {
      name: 'Delete my account',
    }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);

    const input = screen.getByLabelText('Type DELETE to confirm');
    fireEvent.change(input, { target: { value: 'delete' } });
    expect(deleteButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(deleteButton.disabled).toBe(false);
  });

  it('deletes the account and goes to the sign-in page', async () => {
    renderBar();
    openDeleteDialog();
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), {
      target: { value: 'DELETE' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    await waitFor(() => expect(mocks.deleteAccount).toHaveBeenCalledWith('DELETE'));
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/signin?deleted=1'),
    );
  });

  it('keeps the dialog open and shows the server sentence when deletion fails', async () => {
    mocks.deleteAccount.mockRejectedValue(
      new Error('Could not delete the account. Nothing was lost — try again.'),
    );
    renderBar();
    openDeleteDialog();
    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), {
      target: { value: 'DELETE' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not delete the account. Nothing was lost — try again.',
    );
    expect(screen.getByRole('dialog', { name: 'Delete your account' })).toBeTruthy();
  });

  it('cancels without deleting anything', () => {
    renderBar();
    openDeleteDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Keep my account' }));

    expect(screen.queryByRole('dialog', { name: 'Delete your account' })).toBeNull();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });
});
