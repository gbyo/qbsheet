import { useRef, type ReactNode } from 'react';
import { Button, type ButtonVariant } from './Controls';
import { isNativeDirector, openNativeTournamentFile } from '../platform/native';
import type { IconName } from './Icon';

/**
 * One file-choosing affordance.
 *
 * # What this consolidates
 *
 * Opening a tournament used to offer two competing controls on the startup
 * screen: an `Open archive` `<label>` wrapping a hidden file input, styled as a
 * secondary button, and — only in the desktop build — a quiet
 * `Choose file…` button that called the native dialog. Two labels, two visual
 * weights, one task. Elsewhere, imports were a mixture of labels-as-buttons,
 * menu items wrapping inputs, and drop zones.
 *
 * `FilePicker` is now the single affordance: an ordinary Director button that
 * uses the platform dialog in the desktop build and the browser's file input in
 * the browser build. The operator sees one control either way.
 */

export interface PickedFile {
  fileName: string;
  bytes: Uint8Array;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function FilePicker({
  children,
  accept,
  onPick,
  onError,
  variant = 'secondary',
  icon = 'upload',
  multiple = false,
  disabled = false,
  size = 'md',
  /**
   * Prefer the desktop file dialog when running natively. Off for pickers that
   * genuinely want the browser input (drop-zone companions, multi-file import).
   */
  preferNative = false,
}: {
  children: ReactNode;
  accept: string;
  onPick: (files: PickedFile[]) => void | Promise<void>;
  onError?: (message: string) => void;
  variant?: ButtonVariant;
  icon?: IconName;
  multiple?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  preferNative?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const native = preferNative && !multiple && isNativeDirector();

  const openNative = async () => {
    try {
      const selected = await openNativeTournamentFile();
      if (!selected) return;
      await onPick([{ fileName: selected.fileName, bytes: decodeBase64(selected.contentBase64) }]);
    } catch (reason: unknown) {
      onError?.(reason instanceof Error ? reason.message : 'That file could not be opened.');
    }
  };

  return (
    <>
      <Button
        variant={variant}
        icon={icon}
        size={size}
        disabled={disabled}
        onClick={() => {
          if (native) void openNative();
          else inputRef.current?.click();
        }}
      >
        {children}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="director-visually-hidden-input"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (!files.length) return;
          void (async () => {
            try {
              const picked = await Promise.all(
                files.map(async (file) => ({
                  fileName: file.name,
                  bytes: new Uint8Array(await file.arrayBuffer()),
                })),
              );
              await onPick(picked);
            } catch (reason: unknown) {
              onError?.(reason instanceof Error ? reason.message : 'That file could not be read.');
            }
          })();
        }}
      />
    </>
  );
}
