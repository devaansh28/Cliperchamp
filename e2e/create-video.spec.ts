import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const FIXTURES = path.resolve('fixtures/generated');

test('a new user creates, previews, renders and downloads a short video', async ({ page }, testInfo) => {
  const email = `e2e-${Date.now()}@example.com`;

  // Sign up
  await page.goto('/');
  await page.getByRole('link', { name: 'Start free' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-strong-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Create a project
  await page.getByRole('main').getByRole('link', { name: 'New video' }).click();
  await page.getByLabel('Project name').fill('E2E ocean facts');
  await page.getByText('Quick explainer').click();
  await page.getByRole('button', { name: 'Create and open editor' }).click();
  await expect(page.getByTestId('preview')).toBeVisible();

  // Manual script (no LLM configured in this environment)
  await expect(page.getByText('AI script writing is not configured')).toBeVisible();
  await page.getByLabel('Hook').fill('Octopuses have three hearts.');
  await page.getByLabel('Narration 1').fill('And their blood is blue.');
  await page.getByRole('button', { name: 'Save script' }).click();
  await expect(page.getByRole('button', { name: 'Script saved' })).toBeVisible();

  // Upload footage and put it on the timeline
  await page.getByRole('tab', { name: 'Media' }).click();
  await page.getByTestId('media-upload-input').setInputFiles(path.join(FIXTURES, 'background.mp4'));
  await expect(page.locator('[data-testid="media-item"][data-status="ready"]')).toHaveCount(1, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Add background.mp4 to timeline' }).click();
  await expect(page.getByTestId('track-video').getByRole('button', { name: /Video clip 1/u })).toBeVisible();

  // A fake video is rejected
  await page.getByTestId('media-upload-input').setInputFiles(path.join(FIXTURES, 'fake.mp4'));
  await expect(page.getByText('Unsupported file type')).toBeVisible();

  // Voiceover with the free local TTS engine
  await page.getByRole('tab', { name: 'Voice' }).click();
  await page.getByRole('button', { name: 'Generate from script' }).click();
  const voiceItem = page.locator('[data-testid="media-item"][data-status="ready"]').filter({ hasText: 'voice' });
  await expect(voiceItem).toHaveCount(1, { timeout: 60_000 });
  await voiceItem.getByRole('button', { name: /Use .* as narration/u }).click();
  await expect(page.getByTestId('track-narration').getByRole('button')).toHaveCount(1);

  // Captions from the script (estimated timing is labelled as such)
  await page.getByRole('tab', { name: 'Captions' }).click();
  await page.getByRole('button', { name: 'From script' }).click();
  await expect(page.getByText(/use estimated timing/u)).toBeVisible();
  const captionCount = await page.getByTestId('track-captions').getByRole('button').count();
  expect(captionCount).toBeGreaterThan(1);

  // Style change + undo/redo
  await page.getByRole('tab', { name: 'Style' }).click();
  await page.getByRole('button', { name: /Headline/u }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Redo' }).click();

  // Autosave
  await expect(page.getByTestId('save-state-saved')).toBeVisible({ timeout: 15_000 });

  // Preview plays the same composition
  await expect(page.getByTestId('preview').locator('video').first()).toBeAttached();

  // Export a real MP4
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Export MP4' }).click();
  await expect(page.getByTestId('render-active')).toBeVisible();
  await expect(page.getByTestId('render-completed')).toBeVisible({ timeout: 4 * 60_000 });
  await expect(page.getByTestId('render-video')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('editor-exported.png') });

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('render-completed').getByRole('button', { name: 'Download MP4' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^clipforge-[0-9a-f]{8}\.mp4$/u);
  const file = testInfo.outputPath('export.mp4');
  await download.saveAs(file);
  expect(statSync(file).size).toBeGreaterThan(10_000);

  // Independent check of the downloaded file
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,pix_fmt,avg_frame_rate', '-of', 'json', file], { encoding: 'utf8' }),
  ) as { streams: { codec_name: string; width?: number; height?: number; pix_fmt?: string; avg_frame_rate?: string }[] };
  const video = probe.streams.find((s) => s.codec_name === 'h264');
  expect(video).toMatchObject({ width: 1080, height: 1920, pix_fmt: 'yuv420p', avg_frame_rate: '30/1' });
  expect(probe.streams.some((s) => s.codec_name === 'aac')).toBe(true);

  // Reopen: everything was saved
  await page.reload();
  await expect(page.getByTestId('track-video').getByRole('button', { name: /Video clip 1/u })).toBeVisible();
  await expect(page.getByTestId('track-captions').getByRole('button')).toHaveCount(captionCount);
  await page.getByRole('link', { name: 'Back to projects' }).click();
  await expect(page.getByTestId('project-card').filter({ hasText: 'E2E ocean facts' })).toBeVisible();
});

test('another user cannot open someone else’s project', async ({ page, browser }) => {
  await page.goto('/register');
  await page.getByLabel('Email').fill(`owner-${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('a-strong-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('main').getByRole('link', { name: 'New video' }).click();
  await page.getByRole('button', { name: 'Create and open editor' }).click();
  await expect(page.getByTestId('preview')).toBeVisible();
  const editorUrl = page.url();

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto('/register');
  await otherPage.getByLabel('Email').fill(`intruder-${Date.now()}@example.com`);
  await otherPage.getByLabel('Password').fill('a-strong-password');
  await otherPage.getByRole('button', { name: 'Create account' }).click();
  await expect(otherPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await otherPage.goto(editorUrl);
  await expect(otherPage.getByText('Project not found')).toBeVisible();
  await other.close();
});

test('social accounts show as not set up when the server has no platform apps', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Email').fill(`social-${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('a-strong-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.goto('/app/settings');
  const card = page.getByTestId('connected-accounts');
  for (const platform of ['youtube', 'tiktok', 'instagram']) {
    await expect(card.getByTestId(`platform-${platform}`)).toContainText('Not set up on this server');
  }
  // An OAuth error bounced back from the API is shown to the user and removed from the URL.
  await page.goto('/app/settings?social=error&message=Connection+cancelled.#accounts');
  await expect(page.getByText('Connection cancelled.')).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings$|\/app\/settings#accounts$/u);

  await page.goto('/app/projects/new');
  await page.getByRole('button', { name: 'Create and open editor' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByTestId('publish-panel')).toContainText('No accounts connected yet');
});
