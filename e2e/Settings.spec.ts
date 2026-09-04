import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 320, height: 568 } });

/**
 * Root Settings on the narrowest phone this application claims to support.
 *
 * The old assertion here was that the root *scrolled* — it had to, because everything was on it.
 * Reducing that is the point of the progressive-disclosure layout, so what is checked now is what
 * still has to be true whether it scrolls or not: the dialog is inside the viewport, nothing runs off
 * the side of it, every row is a real target, and the detail views that genuinely are long still
 * scroll on their own.
 */
test('root Settings fits a phone, stays compact, and restores focus to the cog', async ({ page }) => {
  await page.goto('/');
  const cog = page.getByRole('button', { name: 'Settings' });
  await cog.click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  // The whole row is the button, and it is still where focus lands.
  await expect(page.getByRole('button', { name: 'Scorekeeper Not set' })).toBeFocused();

  const layout = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowY: getComputedStyle(element).overflowY,
    };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(320);
  expect(layout.bottom).toBeLessThanOrEqual(568);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.overflowY).toBe('auto');

  // Every top-level row is on screen without hunting for it.
  for (const name of ['Scorekeeper Not set', /^Appearance/, /^Recovery/, 'Check this device', 'Advanced']) {
    await expect(dialog.getByRole('button', { name })).toBeInViewport();
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(cog).toBeFocused();
});

test('the subviews hold the detail, scroll when they need to, and come back', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  const root = page.getByRole('dialog', { name: 'Settings' });

  // Appearance: both controls, neither of them on the root.
  await expect(root.getByRole('radiogroup', { name: 'Appearance' })).toHaveCount(0);
  await root.getByRole('button', { name: /^Appearance/ }).click();
  const appearance = page.getByRole('dialog', { name: 'Appearance' });
  await expect(appearance.getByRole('radiogroup', { name: 'Appearance' })).toBeVisible();
  await expect(appearance.getByRole('radiogroup', { name: 'Text size' })).toBeVisible();
  const appearanceLayout = await appearance.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(appearanceLayout.scrollWidth).toBeLessThanOrEqual(appearanceLayout.clientWidth);

  await appearance.getByText('Large', { exact: true }).click();
  await appearance.getByRole('button', { name: 'Back to Settings' }).click();
  // The root row answers with the value that was just chosen, at the size that was just chosen.
  await expect(root.getByRole('button', { name: /^Appearance .* · Large$/ })).toBeVisible();

  // Keyboard shortcuts: the reference is long enough to scroll, and only offered when it applies.
  await expect(root.getByRole('button', { name: 'Keyboard shortcuts' })).toHaveCount(0);
  // The checkbox itself is offscreen behind the track it draws; the label is what a person presses.
  await root.locator('label.settings-switch').click();
  await expect(root.getByRole('switch', { name: 'Keyboard scoring' })).toBeChecked();
  await root.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  const shortcutLayout = await shortcuts.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(shortcutLayout.scrollWidth).toBeLessThanOrEqual(shortcutLayout.clientWidth);
  expect(shortcutLayout.scrollHeight).toBeGreaterThan(shortcutLayout.clientHeight);
  expect(shortcutLayout.overflowY).toBe('auto');
  const back = shortcuts.getByRole('button', { name: 'Back to Settings' });
  await back.scrollIntoViewIfNeeded();
  await back.click();

  // Advanced: the destructive action is one door in, and its Cancel comes back to that door.
  await root.getByRole('button', { name: 'Advanced' }).click();
  const advanced = page.getByRole('dialog', { name: 'Advanced' });
  await advanced.getByRole('button', { name: 'Reset device preferences…' }).click();
  const reset = page.getByRole('dialog', { name: 'Reset device preferences?' });
  await expect(reset).toBeVisible();
  await reset.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog', { name: 'Advanced' })).toBeVisible();
  await advanced.getByRole('button', { name: 'Back to Settings' }).click();
  await expect(root).toBeVisible();
});
