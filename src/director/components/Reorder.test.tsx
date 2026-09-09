import { readFileSync } from 'node:fs';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReorderHandle, useDragReorder } from './Reorder';

type DirectorTauriConfig = {
  app: {
    windows: Array<{
      label: string;
      dragDropEnabled?: boolean;
    }>;
  };
};

function readDirectorTauriConfig(): DirectorTauriConfig {
  const configUrl = new URL('../../../apps/director/src-tauri/tauri.conf.json', import.meta.url);
  return JSON.parse(readFileSync(configUrl, 'utf8')) as DirectorTauriConfig;
}

describe('Director drag reorder', () => {
  it('leaves HTML5 drag and drop to the webview in the desktop app', () => {
    const mainWindow = readDirectorTauriConfig().app.windows.find((window) => window.label === 'main');
    expect(mainWindow?.dragDropEnabled).toBe(false);
  });

  it('moves an item when its grip is dragged onto another grip', () => {
    const onReorder = vi.fn();

    function Harness() {
      const drag = useDragReorder(onReorder);
      return (
        <>
          <ReorderHandle
            label="Round 1"
            index={0}
            count={2}
            onMove={() => {}}
            {...drag.handlers(0)}
          />
          <ReorderHandle
            label="Round 2"
            index={1}
            count={2}
            onMove={() => {}}
            {...drag.handlers(1)}
          />
        </>
      );
    }

    const { container } = render(<Harness />);
    const grips = container.querySelectorAll<HTMLElement>('.director-reorder-grip');
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn(),
    };

    fireEvent.dragStart(grips[0], { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', '0');

    fireEvent.dragOver(grips[1], { dataTransfer });
    fireEvent.drop(grips[1], { dataTransfer });

    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });
});
