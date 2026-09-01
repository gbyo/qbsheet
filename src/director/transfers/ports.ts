/**
 * The two things Transfers needs from a platform, and nothing else.
 *
 * # Why an interface rather than calling Tauri directly
 *
 * Removable media is the least testable thing in the product. A test that needs a real USB stick
 * runs on one developer's machine on a good day and never in CI, which means the interesting cases
 * — the drive that vanishes mid-read, the drive that is read-only, the drive that is full — get
 * tested by a tournament instead.
 *
 * So enumeration and file access are a port. The native implementation talks to Rust, the browser
 * implementation reports honestly that it cannot enumerate anything, and `MemoryTransferFileSystem`
 * below lets a test unplug a drive between two lines of code. Platform behaviour is then a property
 * of one small adapter rather than of the whole subsystem.
 *
 * # Deliberately small
 *
 * List, read, write, make a directory, and say which volumes exist. No delete, no move, no
 * recursive anything, no execute. A feature that reads other people's USB sticks should be able to
 * state its whole vocabulary in one sentence.
 */

export interface TransferVolume {
  /** Stable enough to key on across a poll: the mount point. */
  mountPoint: string;
  /** The volume's own name where the OS reports one, e.g. "SanDisk Ultra". */
  name: string;
  removable: boolean;
  readOnly: boolean;
  totalBytes?: number;
  availableBytes?: number;
  fileSystem?: string;
}

export interface TransferDirectoryEntry {
  name: string;
  path: string;
  directory: boolean;
  byteLength: number;
  modifiedAt?: string;
  /**
   * True when the entry is a symbolic link.
   *
   * Reported rather than silently skipped so the caller can say why a file was ignored. A link on
   * removable media is either a packaging artefact or an attempt to make Director read something
   * outside the folder it was pointed at; neither is a file to open.
   */
  symlink?: boolean;
}

export interface TransferReadResult {
  bytes: Uint8Array;
  byteLength: number;
}

/**
 * A filesystem, as far as Transfers is concerned.
 *
 * Every method may reject. A drive pulled mid-operation, a folder a sync client is rewriting, and a
 * network share that dropped all surface as a rejection with a message meant for a person, and the
 * callers here are written to expect that as a normal event rather than an exception.
 */
export interface TransferFileSystem {
  readonly kind: 'native' | 'memory' | 'unavailable';
  /** Non-recursive. `limit` bounds what is returned; the caller states what it can handle. */
  listDirectory(path: string, limit: number): Promise<TransferDirectoryEntry[]>;
  readFile(path: string, maxBytes: number): Promise<TransferReadResult>;
  /** Atomic: a reader never sees a half-written file at `path`. */
  writeFileAtomic(path: string, contents: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Free space at a path, when the platform can report it. */
  availableBytes(path: string): Promise<number | undefined>;
}

export interface RemovableVolumeSource {
  readonly kind: 'native' | 'memory' | 'unavailable';
  /** Every mounted volume the platform can see. Filtering to removable ones is the caller's job. */
  listVolumes(): Promise<TransferVolume[]>;
}

export class UnavailableTransferFileSystem implements TransferFileSystem, RemovableVolumeSource {
  readonly kind = 'unavailable' as const;
  constructor(private readonly reason: string) {}
  private fail(): never {
    throw new Error(this.reason);
  }
  async listDirectory(): Promise<TransferDirectoryEntry[]> {
    return this.fail();
  }
  async readFile(): Promise<TransferReadResult> {
    return this.fail();
  }
  async writeFileAtomic(): Promise<void> {
    return this.fail();
  }
  async createDirectory(): Promise<void> {
    return this.fail();
  }
  async exists(): Promise<boolean> {
    return false;
  }
  async availableBytes(): Promise<number | undefined> {
    return undefined;
  }
  async listVolumes(): Promise<TransferVolume[]> {
    return [];
  }
}

interface MemoryVolumeOptions {
  name: string;
  removable?: boolean;
  readOnly?: boolean;
  availableBytes?: number;
}

/**
 * A write ceiling independent of the free space the volume reports.
 *
 * Real media does this: the operating system says there is room, and the write fails anyway because
 * another process took the space, or the filesystem has a limit of its own. Modelling the two
 * separately is what lets a test exercise the case Director must handle worst — a prepare that
 * succeeds for eight files and fails for the ninth.
 */
interface MemoryWriteBudget {
  remaining: number;
}

/**
 * A filesystem in a map, with the failure modes real media has.
 *
 * Used by the tests to do the things a physical stick will not do on demand: disappear halfway
 * through a scan, refuse a write because it is read-only, refuse a write because it is full, and
 * come back with its contents changed. The atomic write is modelled honestly — the visible entry is
 * only ever the complete contents — so a test can assert that a failed write left nothing behind.
 */
export class MemoryTransferFileSystem implements TransferFileSystem, RemovableVolumeSource {
  readonly kind = 'memory' as const;
  private readonly files = new Map<string, string>();
  private readonly directories = new Set<string>();
  private readonly volumes = new Map<string, TransferVolume>();
  private readonly symlinks = new Set<string>();

  /** Paths whose next access rejects, simulating media pulled at the worst moment. */
  readonly failing = new Set<string>();
  private readonly writeBudgets = new Map<string, MemoryWriteBudget>();

  /** Cap total bytes written under a mount point, regardless of the free space it reports. */
  setWriteBudget(mountPoint: string, bytes: number): void {
    this.writeBudgets.set(this.normalize(mountPoint), { remaining: bytes });
  }

  addVolume(mountPoint: string, options: MemoryVolumeOptions): void {
    this.volumes.set(mountPoint, {
      mountPoint,
      name: options.name,
      removable: options.removable ?? true,
      readOnly: options.readOnly ?? false,
      availableBytes: options.availableBytes,
    });
    this.directories.add(this.normalize(mountPoint));
  }

  removeVolume(mountPoint: string): void {
    this.volumes.delete(mountPoint);
    const prefix = `${this.normalize(mountPoint)}/`;
    for (const path of [...this.files.keys()]) if (path.startsWith(prefix)) this.files.delete(path);
    for (const path of [...this.directories]) if (path.startsWith(prefix)) this.directories.delete(path);
    this.directories.delete(this.normalize(mountPoint));
  }

  setReadOnly(mountPoint: string, readOnly: boolean): void {
    const volume = this.volumes.get(mountPoint);
    if (volume) this.volumes.set(mountPoint, { ...volume, readOnly });
  }

  setAvailableBytes(mountPoint: string, bytes: number): void {
    const volume = this.volumes.get(mountPoint);
    if (volume) this.volumes.set(mountPoint, { ...volume, availableBytes: bytes });
  }

  putFile(path: string, contents: string): void {
    const normalized = this.normalize(path);
    this.files.set(normalized, contents);
    this.ensureParents(normalized);
  }

  putSymlink(path: string, contents = '{}'): void {
    const normalized = this.normalize(path);
    this.putFile(normalized, contents);
    this.symlinks.add(normalized);
  }

  readSync(path: string): string | undefined {
    return this.files.get(this.normalize(path));
  }

  allPaths(): string[] {
    return [...this.files.keys()].sort();
  }

  private normalize(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  }

  private ensureParents(path: string): void {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
      if (directory) this.directories.add(directory);
    }
  }

  private guard(path: string): void {
    const normalized = this.normalize(path);
    for (const failing of this.failing) {
      if (normalized === this.normalize(failing) || normalized.startsWith(`${this.normalize(failing)}/`))
        throw new Error('The drive is no longer available.');
    }
    const volume = [...this.volumes.values()].find((entry) =>
      normalized.startsWith(this.normalize(entry.mountPoint)),
    );
    if (!volume && !this.directories.has(normalized) && !this.files.has(normalized)) {
      const parent = normalized.slice(0, normalized.lastIndexOf('/'));
      if (parent && !this.directories.has(parent)) throw new Error('That location is no longer available.');
    }
  }

  private volumeFor(path: string): TransferVolume | undefined {
    const normalized = this.normalize(path);
    return [...this.volumes.values()]
      .filter((entry) => normalized.startsWith(this.normalize(entry.mountPoint)))
      .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
  }

  async listDirectory(path: string, limit: number): Promise<TransferDirectoryEntry[]> {
    this.guard(path);
    const prefix = `${this.normalize(path)}/`;
    const names = new Map<string, TransferDirectoryEntry>();
    for (const [filePath, contents] of this.files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const [name, ...tail] = rest.split('/');
      if (tail.length > 0) {
        names.set(name, { name, path: `${prefix}${name}`, directory: true, byteLength: 0 });
      } else {
        names.set(name, {
          name,
          path: filePath,
          directory: false,
          byteLength: new TextEncoder().encode(contents).byteLength,
          ...(this.symlinks.has(filePath) ? { symlink: true } : {}),
        });
      }
    }
    for (const directory of this.directories) {
      if (!directory.startsWith(prefix)) continue;
      const rest = directory.slice(prefix.length);
      const [name] = rest.split('/');
      if (name && !names.has(name))
        names.set(name, { name, path: `${prefix}${name}`, directory: true, byteLength: 0 });
    }
    return [...names.values()].slice(0, limit);
  }

  async readFile(path: string, maxBytes: number): Promise<TransferReadResult> {
    this.guard(path);
    const contents = this.files.get(this.normalize(path));
    if (contents === undefined) throw new Error('That file is no longer there.');
    const bytes = new TextEncoder().encode(contents);
    if (bytes.byteLength > maxBytes) throw new Error('That file is too large to read as QBJ.');
    return { bytes, byteLength: bytes.byteLength };
  }

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    this.guard(path);
    const volume = this.volumeFor(path);
    if (volume?.readOnly) throw new Error('The drive is read-only.');
    const size = new TextEncoder().encode(contents).byteLength;
    if (volume?.availableBytes !== undefined && size > volume.availableBytes)
      throw new Error('There is not enough space on the drive.');
    const budget = volume ? this.writeBudgets.get(this.normalize(volume.mountPoint)) : undefined;
    if (budget && size > budget.remaining) throw new Error('There is not enough space on the drive.');
    if (volume?.availableBytes !== undefined)
      this.setAvailableBytes(volume.mountPoint, volume.availableBytes - size);
    if (budget) budget.remaining -= size;
    this.putFile(path, contents);
  }

  async createDirectory(path: string): Promise<void> {
    this.guard(path);
    const volume = this.volumeFor(path);
    if (volume?.readOnly) throw new Error('The drive is read-only.');
    const normalized = this.normalize(path);
    this.directories.add(normalized);
    this.ensureParents(normalized);
  }

  async exists(path: string): Promise<boolean> {
    // Guarded, because "the mount point is unreadable" and "there is no such folder" are different
    // answers and the caller reports them differently: one is an error the director should see, the
    // other is simply a location that has not been set up yet.
    this.guard(path);
    const normalized = this.normalize(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async availableBytes(path: string): Promise<number | undefined> {
    return this.volumeFor(path)?.availableBytes;
  }

  async listVolumes(): Promise<TransferVolume[]> {
    return [...this.volumes.values()];
  }
}
