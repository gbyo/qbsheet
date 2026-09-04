/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import DeviceReadiness from '../src/app/DeviceReadiness';
import type { IRecoveryUi } from '../src/app/DeviceReadiness';
import SettingsDialog from '../src/app/SettingsDialog';

const originalPicker = Object.getOwnPropertyDescriptor(window, 'showDirectoryPicker');

function setPickerSupport(supported: boolean): void {
  if (supported) {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn(),
    });
  } else {
    Reflect.deleteProperty(window, 'showDirectoryPicker');
  }
}

function defaultSettingsProps(overrides: Partial<React.ComponentProps<typeof SettingsDialog>> = {}) {
  return {
    operatorName: '',
    onOperatorNameChange: () => undefined,
    connection: null,
    onForgetPairing: () => undefined,
    onResetDevicePreferences: () => undefined,
    onReadiness: () => undefined,
    onClose: () => undefined,
    ...overrides,
  };
}

/**
 * The root Recovery row, and the Settings-owned view behind it.
 *
 * Everything the section used to spell out on the overview now lives here, so every case below goes
 * through the door first rather than reaching past it.
 */
function openRecoveryView(): HTMLElement {
  const settings = screen.getByRole('dialog', { name: 'Settings' });
  fireEvent.click(within(settings).getByRole('button', { name: /^Recovery/ }));
  return screen.getByRole('dialog', { name: 'Recovery' });
}

async function openReadiness(recovery?: IRecoveryUi): Promise<void> {
  await act(async () => {
    render(<DeviceReadiness durable recovery={recovery} onBack={() => undefined} />);
  });
  await waitFor(() => expect(screen.queryByText('Checking this device…')).toBeNull());
}

beforeEach(() => {
  setPickerSupport(false);
});

afterEach(() => {
  cleanup();
  if (originalPicker) Object.defineProperty(window, 'showDirectoryPicker', originalPicker);
  else Reflect.deleteProperty(window, 'showDirectoryPicker');
});

describe('Settings recovery section', () => {
  test('keeps local protection mandatory and exposes explicit external setup', async () => {
    setPickerSupport(true);
    const setup = vi.fn();
    const refresh = vi.fn();
    render(
      <SettingsDialog
        {...defaultSettingsProps()}
        recovery={{
          externalBackup: { state: 'not-configured' },
          onSetupExternalBackup: setup,
          onRefreshRecoveryStatus: refresh,
        }}
      />,
    );

    // The root carries one compact, truthful summary and nothing else about recovery.
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(
      within(dialog).getByRole('button', { name: 'Recovery Protected · Not configured' }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText('Automatic protection')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Set up external backup…' })).toBeNull();

    const view = openRecoveryView();
    expect(within(view).getByText('Automatic protection')).toBeInTheDocument();
    expect(within(view).getByText(/^Protected/)).toBeInTheDocument();
    expect(within(view).getByText('External backup')).toBeInTheDocument();
    expect(within(view).getByText('Not configured')).toBeInTheDocument();
    expect(within(view).queryByRole('switch', { name: /local protection|automatic protection/i })).toBeNull();

    fireEvent.click(within(view).getByRole('button', { name: 'Set up external backup…' }));
    expect(setup).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    fireEvent.click(within(view).getByRole('button', { name: 'Back to Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  test('opens a status view for management and never removes files when configuration is stopped', async () => {
    setPickerSupport(true);
    const remove = vi.fn();
    render(
      <SettingsDialog
        {...defaultSettingsProps()}
        recovery={{
          externalBackup: { state: 'ready', folderName: 'QBSheet Backups', lastSavedAt: Date.now() },
          onRemoveExternalBackup: remove,
        }}
      />,
    );

    // The folder is named on the root row, and dated inside the view.
    expect(screen.getByRole('button', { name: 'Recovery Protected · QBSheet Backups' })).toBeInTheDocument();

    const recoveryDialog = openRecoveryView();
    expect(recoveryDialog).toHaveTextContent('QBSheet Backups');
    expect(recoveryDialog).toHaveTextContent('Saved just now');

    fireEvent.click(within(recoveryDialog).getByRole('button', { name: 'Stop external backup…' }));
    expect(recoveryDialog).toHaveTextContent(/will not delete any existing\s+\.qbsheet\s+files/);
    fireEvent.click(within(recoveryDialog).getByRole('button', { name: 'Stop external backup' }));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('shows needs-permission and only invokes reconnect after an explicit click', async () => {
    setPickerSupport(true);
    const reconnect = vi.fn();
    render(
      <SettingsDialog
        {...defaultSettingsProps()}
        recovery={{
          externalBackup: { state: 'needs-permission' },
          onReconnectExternalBackup: reconnect,
        }}
      />,
    );

    expect(reconnect).not.toHaveBeenCalled();
    const view = openRecoveryView();
    expect(reconnect).not.toHaveBeenCalled();
    fireEvent.click(within(view).getByRole('button', { name: 'Allow access' }));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  test('the root row opens the Settings view even when a host Recovery Mode is on offer', () => {
    const viewRecovery = vi.fn();
    const close = vi.fn();
    render(
      <SettingsDialog
        {...defaultSettingsProps({ onClose: close })}
        recovery={{
          externalBackup: { state: 'unsupported' },
          onViewRecoveryStatus: viewRecovery,
        }}
      />,
    );

    expect(viewRecovery).not.toHaveBeenCalled();
    const view = openRecoveryView();
    // The row is a way into recovery management, not a shortcut past it.
    expect(close).not.toHaveBeenCalled();
    expect(viewRecovery).not.toHaveBeenCalled();
    expect(within(view).getByText('Automatic protection')).toBeInTheDocument();
  });

  test('the host Recovery Mode is entered only by the button that says so', () => {
    const viewRecovery = vi.fn();
    const close = vi.fn();
    render(
      <SettingsDialog
        {...defaultSettingsProps({ onClose: close })}
        recovery={{
          externalBackup: { state: 'unsupported' },
          onViewRecoveryStatus: viewRecovery,
        }}
      />,
    );

    const view = openRecoveryView();
    fireEvent.click(within(view).getByRole('button', { name: 'Open full recovery status' }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(viewRecovery).toHaveBeenCalledTimes(1);
  });

  test('surfaces an injected backup failure instead of claiming it is ready', async () => {
    setPickerSupport(true);
    const reconnect = vi.fn(() => ({ ok: false as const, message: 'The folder is read-only.' }));
    render(
      <SettingsDialog
        {...defaultSettingsProps()}
        recovery={{
          externalBackup: { state: 'needs-permission' },
          onReconnectExternalBackup: reconnect,
        }}
      />,
    );

    fireEvent.click(within(openRecoveryView()).getByRole('button', { name: 'Allow access' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The folder is read-only.');
  });

  test('a folder change stays available beside the removal confirmation', async () => {
    setPickerSupport(true);
    const setup = vi.fn();
    render(
      <SettingsDialog
        {...defaultSettingsProps()}
        recovery={{
          externalBackup: { state: 'ready', folderName: 'QBSheet Backups', lastSavedAt: Date.now() },
          onSetupExternalBackup: setup,
        }}
      />,
    );

    const view = openRecoveryView();
    fireEvent.click(within(view).getByRole('button', { name: 'Change folder…' }));
    expect(setup).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(within(view).getByRole('status')).toHaveTextContent('External backup folder changed.'),
    );
  });
});

describe('Device Readiness recovery reporting', () => {
  test('feature-detects support without opening a picker or requesting permission', async () => {
    setPickerSupport(true);
    const picker = (window as unknown as { showDirectoryPicker: ReturnType<typeof vi.fn> })
      .showDirectoryPicker;
    const requestPermission = vi.fn();
    const onReconnect = vi.fn();

    await openReadiness({
      externalBackup: {
        state: 'ready',
        folderName: 'QBSheet Backups',
        lastSavedAt: Date.now(),
      },
      onReconnectExternalBackup: onReconnect,
    });

    expect(screen.getByText('External backup support')).toBeInTheDocument();
    expect(screen.getByText(/supports the optional external \.qbsheet backup folder/i)).toBeInTheDocument();
    expect(screen.getByText(/QBSheet Backups · Saved just now/i)).toBeInTheDocument();
    expect(picker).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  test('reports an unsupported browser as informational, not a core failure', async () => {
    await openReadiness();

    expect(screen.getByText('External backup support')).toBeInTheDocument();
    expect(screen.getByText(/does not support optional external backup folders/i)).toBeInTheDocument();
    expect(screen.getByText(/optional layer, not a failure of local QBSheet recovery/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /external backup|reconnect/i })).toBeNull();
  });

  test('renders needs-permission honestly and keeps reconnect user-driven', async () => {
    setPickerSupport(true);
    const reconnect = vi.fn();
    await openReadiness({
      externalBackup: { state: 'needs-permission' },
      onReconnectExternalBackup: reconnect,
    });

    expect(screen.getByText(/needs permission again/i)).toBeInTheDocument();
    expect(reconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect external backup' }));
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
