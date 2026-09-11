/**
 * The bundle configuration, checked in milliseconds rather than on a release runner.
 *
 * The same guard Director carries, for the same reason it was written: a `bundle.icon` list that
 * names `icons/icon.icon` kills a macOS build inside Xcode's `actool` with one opaque line, after
 * a full compile. `icon.icon` is an Icon Composer *source directory*, not an image. It lives in
 * the tree as the design input the raster icons were generated from, and it must never appear in
 * a `bundle.icon` list. See `docs/DIRECTOR_RELEASE.md`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcTauri = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');

const bundleConfigs = ['tauri.conf.json', 'tauri.macos.conf.json'];

describe('QBSheet Bridge bundle configuration', () => {
  it('every icon in every bundle config is a real image file', () => {
    for (const file of bundleConfigs) {
      const raw = JSON.parse(readFileSync(join(srcTauri, file), 'utf8')) as {
        bundle?: { icon?: unknown };
      };
      const icons = raw.bundle?.icon;
      if (icons === undefined) continue;
      expect(Array.isArray(icons), `${file} bundle.icon is not a list`).toBe(true);
      for (const icon of icons as unknown[]) {
        expect(typeof icon, `${file} has a non-path icon entry`).toBe('string');
        const path = join(srcTauri, icon as string);
        expect(existsSync(path), `${file} references missing icon ${icon}`).toBe(true);
        expect(statSync(path).isFile(), `${file} icon ${icon} is not a file`).toBe(true);
      }
    }
  });

  it('the Icon Composer source is present and is not bundled', () => {
    expect(statSync(join(srcTauri, 'icons/icon.icon')).isDirectory()).toBe(true);
    for (const file of bundleConfigs) {
      expect(readFileSync(join(srcTauri, file), 'utf8')).not.toContain('icon.icon');
    }
  });

  it('the window and the product are both named QBSheet Bridge', () => {
    const raw = JSON.parse(readFileSync(join(srcTauri, 'tauri.conf.json'), 'utf8')) as {
      productName?: string;
      identifier?: string;
      app?: { windows?: { title?: string }[] };
    };
    expect(raw.productName).toBe('QBSheet Bridge');
    expect(raw.identifier).toBe('com.qbsheet.bridge');
    expect(raw.app?.windows?.[0]?.title).toBe('QBSheet Bridge');
  });

  it('the macOS config keeps the same deployment floor Director ships against', () => {
    const raw = JSON.parse(readFileSync(join(srcTauri, 'tauri.macos.conf.json'), 'utf8')) as {
      bundle?: { macOS?: { minimumSystemVersion?: unknown } };
    };
    expect(raw.bundle?.macOS?.minimumSystemVersion).toBe('11.0');
  });
});

describe('QBSheet Bridge dual-scope Windows installer', () => {
  const templatePath = join(srcTauri, 'wix', 'main.wxs');
  const template = () => readFileSync(templatePath, 'utf8');
  const baseConfig = () =>
    JSON.parse(readFileSync(join(srcTauri, 'tauri.conf.json'), 'utf8')) as {
      bundle?: { windows?: { wix?: { template?: unknown } } };
    };

  it('points the Windows MSI build at the owned WiX template', () => {
    expect(baseConfig().bundle?.windows?.wix?.template).toBe('wix/main.wxs');
    expect(existsSync(templatePath)).toBe(true);
  });

  it('declares its stock base so Tauri upgrades stay honest', () => {
    // The header must name the tauri-apps/tauri tag the template was derived from, and the
    // tag's minor version must match the pinned CLI: a silent bundler change must never desync
    // the documented divergences. Patch moves are fine; minor moves fail until the template is
    // re-diffed and the base tag follows.
    const qbbridgePackage = JSON.parse(readFileSync(join(srcTauri, '..', 'package.json'), 'utf8')) as {
      devDependencies?: { '@tauri-apps/cli'?: string };
    };
    const minor = (qbbridgePackage.devDependencies?.['@tauri-apps/cli'] ?? '')
      .replace(/^[^\d]*/, '')
      .split('.')
      .slice(0, 2)
      .join('.');
    expect(minor).toMatch(/^\d+\.\d+$/);
    expect(template()).toContain(`tag tauri-v${minor}.`);
  });

  it('stays a dual-scope single package defaulting to Standard', () => {
    const text = template();
    // MSI 5.0 is required for the ALLUSERS=2 / MSIINSTALLPERUSER model. InstallScope stays
    // OFF Package entirely: candle synthesizes Property ALLUSERS=1 from
    // InstallScope="perMachine", which collides at link time (LGHT0091) with the
    // ALLUSERS=2 row the single-package pattern requires.
    expect(text).toContain('InstallerVersion="500"');
    const pkg = text.match(/<Package[\s\S]*?\/>/)?.[0] ?? '';
    expect(pkg).not.toContain('InstallScope');
    expect(text).toContain('<Property Id="ALLUSERS" Value="2" Secure="yes" />');
    // MSIINSTALLPERUSER must be declared with NO Value attribute: candle rejects
    // Value="" with CNDL0006, while an unset property still means per-machine.
    expect(text).toContain('<Property Id="MSIINSTALLPERUSER" Secure="yes" />');
    expect(text).not.toContain('MSIINSTALLPERUSER" Value=""');
    expect(text).toContain('<Property Id="QBB_INSTALLSCOPE" Value="perMachine" Secure="yes" />');
    expect(text).toContain('QBB_INSTALLSCOPE = "perUser"');
  });

  it('wires the scope dialog into the no-license installer chain', () => {
    const text = template();
    // The dialog must not reuse the stock InstallScopeDlg name the WixUIExtension ships;
    // that symbol collides at link time (LGHT0091).
    expect(text).not.toMatch(/Id="InstallScopeDlg"/);
    expect(text).toContain('Id="QbbInstallScopeDlg"');
    expect(text).toContain('Value="QbbInstallScopeDlg"');
    expect(text).toContain('Value="perMachine"');
    expect(text).toContain('Value="perUser"');
  });

  it('configures no license file, so the scope dialog stays live', () => {
    // The scope dialog is wired inside the template's no-license chain. Configuring a license
    // file would silently orphan it and drop scope selection, so that change must update the
    // template first.
    expect(readFileSync(join(srcTauri, 'tauri.conf.json'), 'utf8').toLowerCase()).not.toContain('license');
  });

  it('refuses conflicting copies with upgrade and maintenance carve-outs', () => {
    const text = template();
    expect(text).toContain('Id="CMP_PerMachineMarker"');
    expect(text).toContain('<Condition>NOT MSIINSTALLPERUSER</Condition>');
    expect(text).toContain('Name="InstalledAllUsers"');
    expect(text).toContain('<ComponentRef Id="CMP_PerMachineMarker"/>');
    // The per-user marker is the mirror image: written only by Current-user installs,
    // so the per-user search is a precise per-user-copy signal rather than InstallDir,
    // which every install writes.
    expect(text).toContain('Id="CMP_PerUserMarker"');
    expect(text).toContain('<Condition>MSIINSTALLPERUSER</Condition>');
    expect(text).toContain('Name="InstalledPerUser"');
    expect(text).toContain('<ComponentRef Id="CMP_PerUserMarker"/>');
    for (const marker of [
      'QBB_MACHINE_INSTALL',
      'QBB_USER_INSTALL',
      'QBB_NSIS_USER_UNINSTALL',
      'QBB_NSIS_MACHINE_UNINSTALL',
    ]) {
      expect(text).toContain(marker);
    }
    // Every launch condition leaves same-context upgrades and maintenance alone, so repair,
    // uninstall, and version upgrades never trip on their own product.
    const conditions = text.match(/<Condition Message="[^"]*">([^<]*)<\/Condition>/g) ?? [];
    expect(conditions.length).toBeGreaterThanOrEqual(4);
    for (const condition of conditions) {
      expect(condition).toContain('UPGRADINGPRODUCTCODE');
      expect(condition).toContain('Installed');
    }
  });

  it('keeps per-machine writes to the marker and the unused deep-link block', () => {
    // Per-user safety rests on every install location and registry write being
    // context-relative. RegistrySearch rows only read, in any context; the only HKLM writes
    // allowed are the per-machine marker and the deep-link block, which renders empty while
    // QBBridge configures no deep-link protocols.
    const hklmLines = template()
      .split('\n')
      .filter((line) => line.includes('Root="HKLM"'));
    const writes = hklmLines.filter((line) => !line.includes('RegistrySearch'));
    expect(writes).toHaveLength(2);
    expect(writes.some((line) => line.includes('InstalledAllUsers'))).toBe(true);
    expect(writes.some((line) => line.includes('{{protocol}}'))).toBe(true);
    const config = readFileSync(join(srcTauri, 'tauri.conf.json'), 'utf8').toLowerCase();
    expect(config).not.toContain('deep-link');
    expect(config).not.toContain('deeplink');
  });
});
