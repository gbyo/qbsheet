import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 320, height: 568 } });

test('Settings stays inside a phone viewport, scrolls internally, and restores focus to the cog', async ({
  page,
}) => {
  await page.goto('/');
  const cog = page.getByRole('button', { name: 'Settings' });
  await cog.click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set name' })).toBeFocused();

  const layout = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    };
  });
  expect(layout.left).toBeGreaterThanOrEqual(0);
  expect(layout.top).toBeGreaterThanOrEqual(0);
  expect(layout.right).toBeLessThanOrEqual(320);
  expect(layout.bottom).toBeLessThanOrEqual(568);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.overflowY).toBe('auto');

  const reset = page.getByRole('button', { name: 'Reset device preferences…' });
  await reset.scrollIntoViewIfNeeded();
  await expect(reset).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(cog).toBeFocused();
});
