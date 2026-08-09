/**
 * Opening a game file, by picker or by drop.
 *
 * The drop zone is the button. There is no separate dashed rectangle, because a scorekeeper who
 * knows to drag a file will drag it onto the thing that says "Open game file", and one who does not
 * will click it — and a large empty target that does nothing when clicked is worse than no target.
 *
 * Errors from validation are shown in full and in place. A game file that will not open is somebody
 * else's problem to fix, and "That file could not be opened" tells them nothing they can act on.
 */
import { DragEvent, useRef, useState } from 'react';
import { FileGameSource, fileFromDrop, gameFileAccept } from '../integrations/file/FileGameSource';
import { IGamePackage } from '../game/GamePackage';

export default function GameFileOpen(props: {
  label?: string;
  onOpen: (packageValue: IGamePackage) => void | Promise<void>;
}) {
  const { label = 'Open game file', onOpen } = props;
  const input = useRef<HTMLInputElement | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const read = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setErrors([]);
    const result = await new FileGameSource(file).load();
    setBusy(false);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    await onOpen(result.value);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void read(fileFromDrop(event.dataTransfer));
  };

  return (
    <div
      className={dragging ? 'file-open is-dragging' : 'file-open'}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={input}
        type="file"
        className="file-open-input"
        accept={gameFileAccept}
        onChange={(event) => {
          void read(event.target.files?.[0] ?? null);
          // Clear it, so choosing the same file twice in a row still fires a change.
          event.target.value = '';
        }}
      />
      <button type="button" className="shell-button" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Opening…' : label}
      </button>
      {errors.length > 0 && (
        <div className="shell-errors" role="alert">
          <strong>That game file cannot be used.</strong>
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
