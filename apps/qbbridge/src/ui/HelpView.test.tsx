/**
 * The help page, and the claim it makes about how to deploy the relay.
 *
 * A manual that is confidently wrong is worse than no manual, and this one carries shell
 * commands and an environment variable name that live in another workspace. Those are checked
 * against the actual relay deployment rather than trusted — a rename in `wrangler.jsonc` or in
 * the Worker's `Env` fails here instead of stranding an operator at 8am.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { isRelayTournamentId } from '../../../../src/director/relay/relayConfig';
import HelpView from './HelpView';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const relayRoot = resolve(repositoryRoot, 'apps/qbtcp-relay-backend-cloudflare');

function relayFile(path: string): string {
  return readFileSync(resolve(relayRoot, path), 'utf8');
}

describe('the help page', () => {
  test('is a set of sections with a contents list that points at each one', () => {
    render(<HelpView />);

    const headings = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
    expect(headings).toEqual([
      'What QBSheet Bridge does',
      'Setting up the Cloudflare relay',
      'Before the tournament',
      'Running each round',
      'Getting results into YellowFruit',
      'When something goes wrong',
      'What QBSheet Bridge does not do',
    ]);

    // Every entry in the contents list resolves to a section that is actually on the page.
    const contents = screen.getByRole('navigation', { name: 'Help contents' });
    const links = within(contents).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(headings);
    for (const link of links) {
      const id = link.getAttribute('href')?.slice(1) ?? '';
      expect(document.getElementById(id), `${id} is missing`).toBeTruthy();
    }
  });

  test('names the relay secrets the deployment actually reads', () => {
    render(<HelpView />);
    const page = document.body.textContent ?? '';

    // Both are declared in the Worker's environment and set the same way by its README.
    const env = relayFile('src/env.d.ts');
    for (const secret of ['RELAY_SETUP_TOKEN', 'RELAY_ALLOWED_ORIGINS']) {
      expect(env, `${secret} is no longer a relay secret`).toContain(secret);
      expect(page).toContain(`wrangler secret put ${secret}`);
    }
  });

  test('points at the deployment the relay is actually published from', () => {
    render(<HelpView />);
    const page = document.body.textContent ?? '';

    // The path in the README's Deploy to Cloudflare button.
    expect(relayFile('README.md')).toContain('apps/qbtcp-relay-backend-cloudflare');
    expect(page).toContain('github.com/gbyo/qbsheet/tree/main/apps/qbtcp-relay-backend-cloudflare');
    expect(page).toContain('wrangler.jsonc');

    // The Worker name the deployed URL is built from.
    expect(relayFile('wrangler.jsonc')).toContain('"name": "qbtcp-relay-backend"');
    expect(page).toContain('https://qbtcp-relay-backend.your-subdomain.workers.dev');
  });

  test('warns about the origin allowlist, which is what silently stops a room pairing', () => {
    render(<HelpView />);
    const page = document.body.textContent ?? '';
    // The refusal code the relay answers with, so the text matches what an operator would see.
    expect(relayFile('../../src/director/relay/relayConfig.ts')).toContain('https://qbsheet.com');
    expect(page).toContain('403 origin_not_allowed');
    expect(page).toContain('https://qbsheet.com');
  });

  test('describes the workflow at both ends, and the limits QBBridge keeps to', () => {
    render(<HelpView />);
    const page = document.body.textContent ?? '';
    expect(page).toContain('Import Games Only');
    expect(page).toContain('Reload YellowFruit File');
    expect(page).toContain('Publish Room Setup');
    expect(page).toContain('Publish Round');
    // The honest-status rule, restated where an operator will look for it.
    expect(page).toMatch(/never claims a result was imported, accepted or applied to standings/);
  });
});

/**
 * The generators on the help page.
 *
 * They exist because "any long random string" is, in practice, a tired person typing something
 * short into the one credential that lets a stranger claim their relay.
 */
describe('the generators', () => {
  test('a setup token is long, random, and safe to paste through a terminal', async () => {
    const user = userEvent.setup();
    render(<HelpView />);

    await user.click(screen.getByRole('button', { name: 'Generate setup token' }));
    const field = screen.getByRole('textbox', { name: 'setup token' });
    const first = (field as HTMLInputElement).value;

    // base64url: nothing a shell, a text field or a line wrap will mangle.
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Read-only, but selectable — the operator has to be able to copy it by hand.
    expect(field).toHaveAttribute('readonly');
    expect(field).not.toBeDisabled();
    expect(field).toHaveAccessibleDescription(/QBBridge does not store it/);

    await user.click(screen.getByRole('button', { name: 'Generate another' }));
    expect((screen.getByRole('textbox', { name: 'setup token' }) as HTMLInputElement).value).not.toBe(first);
  });

  test('a tournament ID matches the rule the relay enforces', async () => {
    const user = userEvent.setup();
    render(<HelpView />);

    await user.click(screen.getByRole('button', { name: 'Generate tournament ID' }));
    const value = (screen.getByRole('textbox', { name: 'tournament ID' }) as HTMLInputElement).value;

    // `isTournamentId` in the relay: 24 digits and lowercase consonants.
    expect(value).toMatch(/^[0-9b-df-hj-np-tv-z]{24}$/);
    expect(isRelayTournamentId(value)).toBe(true);
  });

  test('copying reports what actually happened', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<HelpView />);
    await user.click(screen.getByRole('button', { name: 'Generate setup token' }));
    const value = (screen.getByRole('textbox', { name: 'setup token' }) as HTMLInputElement).value;
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith(value);
    expect(await screen.findByText('Copied to the clipboard.')).toBeInTheDocument();
  });

  test('a clipboard the webview refuses is reported, not pretended', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });

    render(<HelpView />);
    await user.click(screen.getByRole('button', { name: 'Generate setup token' }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(
      await screen.findByText('Could not reach the clipboard — select the text above and copy it.'),
    ).toBeInTheDocument();
  });

  test('nothing generated here is written to local storage', async () => {
    const user = userEvent.setup();
    render(<HelpView />);
    await user.click(screen.getByRole('button', { name: 'Generate setup token' }));
    const token = (screen.getByRole('textbox', { name: 'setup token' }) as HTMLInputElement).value;

    const stored = Object.keys(globalThis.localStorage).map((key) => globalThis.localStorage.getItem(key));
    expect(stored.join('|')).not.toContain(token);
  });
});
