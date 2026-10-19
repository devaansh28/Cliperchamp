import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Progress } from '@/components/ui/misc';
import { AuthPage } from '@/pages/AuthPage';

describe('AuthPage', () => {
  it('validates email and password before calling the server', async () => {
    render(
      <MemoryRouter>
        <AuthPage mode="register" />
      </MemoryRouter>,
    );
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toMatch(/8 characters/u);
  });
});

describe('Progress', () => {
  it('is determinate with a value and indeterminate without', () => {
    const { rerender } = render(<Progress label="Render" value={0.42} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    rerender(<Progress label="Render" value={null} />);
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });
});
