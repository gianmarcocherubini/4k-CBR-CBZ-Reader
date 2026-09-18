import { expect, type Page, test } from '@playwright/test'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (name: string) => join(here, 'fixtures', name)

test.beforeAll(() => {
  if (!existsSync(fx('short-book.cbz'))) execSync('node scripts/make-fixtures.mjs', { cwd: join(here, '..'), stdio: 'inherit' })
})

async function importAndOpen(page: Page, name: string, title: string) {
  await page.setInputFiles('[data-testid=import-input]', fx(name))
  const overlay = page.getByTestId('import-overlay')
  await expect(overlay.getByText('Importazione completata')).toBeVisible({ timeout: 30_000 })
  await overlay.getByTestId('import-close').click()
  await page.getByRole('button', { name: `Apri ${title}` }).click()
  await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
}

const badge = (page: Page) => page.getByTestId('sr-badge')

/**
 * Width the engine renders on "Auto": a fixed factor of the source, independent of the display.
 * x4 when the result stays within the 16 MP canvas cap (800x1200 -> 3200), else x2 (1000x1500 -> 2000).
 */
function autoWidth(srcW: number, srcH: number): number {
  return srcW * srcH * 16 <= 16 * 1024 * 1024 ? srcW * 4 : srcW * 2
}

test('Anime4K super resolution: enhanced canvas, badge, level probe, faithful output (or clean fallback)', async ({ page }) => {
  await page.goto('/')
  const hasWebGPU = await page.evaluate(async () => !!(navigator as Navigator & { gpu?: GPU }).gpu && !!(await (navigator as Navigator & { gpu?: GPU }).gpu!.requestAdapter()))
  // 800x1200 pages shown at 1640 device px tall: clearly larger than native -> enhanced.
  await importAndOpen(page, 'manga-vol-01.cbz', 'manga-vol-01')
  await page.mouse.move(590, 410) // keep the toolbars visible

  if (!hasWebGPU) {
    await expect(badge(page)).toHaveAttribute('data-sr-state', 'na')
    await page.getByTestId('settings').click()
    await expect(page.getByTestId('sr-status')).toContainText('Non disponibile')
    await expect(page.locator('[data-testid=page][data-page="1"] img')).toBeVisible()
    return
  }

  // First page: pipeline build + VL probe, then the enhanced canvas replaces the <img>.
  const enhanced = page.locator('[data-testid=page][data-page="1"] canvas[data-testid=enhanced]')
  await expect(enhanced).toBeVisible({ timeout: 90_000 })
  // Rendered at a fixed factor of the source (x4 for an 800x1200 page), then fitted to the box:
  // the canvas holds exactly the displayed device pixels, never more than the result itself.
  await expect(enhanced).toHaveAttribute('data-sr-width', String(autoWidth(800, 1200)))
  const box = (await enhanced.boundingBox())!
  await expect.poll(() => enhanced.evaluate((c: HTMLCanvasElement) => c.width)).toBe(Math.round(box.width * 2))
  // The auto level starts at VL and may re-enhance at a stronger level once the probe is in:
  // badge and page attribute must agree once the queue is idle.
  await page.mouse.move(600, 420)
  await expect
    .poll(
      async () => {
        const l = await page.locator('[data-testid=page][data-page="1"]').getAttribute('data-sr')
        const st = await badge(page).getAttribute('data-sr-state')
        const b = await badge(page).getAttribute('aria-label')
        return l && ['M', 'VL', 'UL'].includes(l) && st === 'applied' && b?.includes(`×4 ${l}`) ? l : null
      },
      { timeout: 90_000 },
    )
    .not.toBeNull()
  const level = await page.locator('[data-testid=page][data-page="1"]').getAttribute('data-sr')

  await page.mouse.move(700, 450) // toolbars auto-hide after 2.5 s; a mouse move reveals them
  await page.getByTestId('settings').click()
  await expect(page.getByTestId('sr-status')).toContainText('WebGPU')
  await expect(page.getByTestId('sr-status')).toContainText('livello auto')

  // Faithfulness: the exact 2x output downsampled back must match the source closely (no strip
  // misalignment, no colour drift). Grab the source by switching SR off, then compare.
  await page.getByTestId('scale-x2').click()
  await page.getByRole('switch', { name: 'Super risoluzione' }).click()
  const img = page.locator('[data-testid=page][data-page="1"] img')
  await expect(img).toBeVisible()
  await page.evaluate(async () => {
    const el = document.querySelector('[data-testid=page][data-page="1"] img') as HTMLImageElement
    await el.decode()
    const c = document.createElement('canvas')
    c.width = el.naturalWidth
    c.height = el.naturalHeight
    c.getContext('2d')!.drawImage(el, 0, 0)
    ;(window as unknown as { __src: ImageData }).__src = c.getContext('2d')!.getImageData(0, 0, c.width, c.height)
  })
  await page.getByRole('switch', { name: 'Super risoluzione' }).click()
  await expect(enhanced).toBeVisible({ timeout: 45_000 })
  await expect(enhanced).toHaveAttribute('data-sr-width', '1600', { timeout: 45_000 })
  const psnr = await page.evaluate(() => {
    const src = (window as unknown as { __src: ImageData }).__src
    const canvas = document.querySelector('[data-testid=page][data-page="1"] canvas') as HTMLCanvasElement
    const c = document.createElement('canvas')
    c.width = src.width
    c.height = src.height
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(canvas, 0, 0, src.width, src.height)
    const out = ctx.getImageData(0, 0, src.width, src.height)
    let se = 0
    const n = src.width * src.height
    for (let i = 0; i < n * 4; i += 4) {
      // luma
      const a = 0.299 * src.data[i]! + 0.587 * src.data[i + 1]! + 0.114 * src.data[i + 2]!
      const b = 0.299 * out.data[i]! + 0.587 * out.data[i + 1]! + 0.114 * out.data[i + 2]!
      se += (a - b) * (a - b)
    }
    const mse = se / n
    return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
  })
  console.log(`downsampled enhanced vs source: ${psnr.toFixed(1)} dB (level ${level})`)
  expect(psnr).toBeGreaterThan(28)
  await page.getByTestId('scale-auto').click()

  // Manual level override re-enhances at that level.
  await page.getByTestId('sr-M').click()
  await expect(page.locator('[data-testid=page][data-page="1"]')).toHaveAttribute('data-sr', 'M', { timeout: 45_000 })
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()

  // Turning the page keeps enhancing (preloaded pages are already done or in flight).
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('page-label')).toHaveText('2-3')
  await expect(page.locator('[data-testid=page][data-page="2"] canvas[data-testid=enhanced]')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('[data-testid=page][data-page="3"] canvas[data-testid=enhanced]')).toBeVisible({ timeout: 45_000 })

  // Corner HD indicator: shown once the toolbars hide, "applied" (filled) when SR is on the page.
  const mini = page.getByTestId('sr-mini')
  await page.mouse.move(600, 430) // off the toolbars (hovering them keeps them visible)
  await expect(page.getByTestId('toolbar-top')).toHaveClass(/opacity-0/, { timeout: 6_000 })
  await expect(mini).toBeVisible()
  await expect(mini).toHaveAttribute('data-sr-state', 'applied', { timeout: 45_000 })
  await expect(mini).toHaveText('HD')
  await expect(mini).toHaveAttribute('aria-label', /×4 M/)
  // Hidden while the toolbars (with the full badge) are visible, and when switched off.
  await page.mouse.move(640, 450)
  await expect(mini).toHaveCount(0)
  await page.getByTestId('settings').click()
  await page.getByRole('switch', { name: 'Indicatore HD' }).click()
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()
  await page.mouse.move(600, 430)
  await expect(page.getByTestId('toolbar-top')).toHaveClass(/opacity-0/, { timeout: 6_000 })
  await expect(mini).toHaveCount(0)
})

test('SR first, fit after: a page already at screen size is enhanced x2, and zooming reuses the result', async ({ page }) => {
  await page.goto('/')
  const hasWebGPU = await page.evaluate(async () => !!(navigator as Navigator & { gpu?: GPU }).gpu && !!(await (navigator as Navigator & { gpu?: GPU }).gpu!.requestAdapter()))
  test.skip(!hasWebGPU, 'needs WebGPU')
  // 1000x1500 pages at 1640 device px tall: x4 would exceed the 16 MP cap, so the engine runs x2.
  await importAndOpen(page, 'short-book.cbz', 'short-book')
  const enhanced = page.locator('[data-testid=page][data-page="1"] canvas[data-testid=enhanced]')
  await expect(enhanced).toBeVisible({ timeout: 60_000 })
  await expect(enhanced).toHaveAttribute('data-sr-width', String(autoWidth(1000, 1500)))
  await page.mouse.move(590, 410)
  await expect(badge(page)).toHaveAttribute('aria-label', /SR ×2 (M|VL|UL)$/, { timeout: 60_000 })
  const before = await enhanced.evaluate((c: HTMLCanvasElement) => c.width)
  // Zooming in does not recompute anything: same result, refitted at the larger displayed size.
  await page.mouse.dblclick(590, 410)
  await expect.poll(() => enhanced.evaluate((c: HTMLCanvasElement) => c.width), { timeout: 5_000 }).toBeGreaterThan(before)
  await expect(enhanced).toHaveAttribute('data-sr-width', String(autoWidth(1000, 1500)))
  await expect(badge(page)).toHaveAttribute('aria-label', /SR ×2 (M|VL|UL)$/)
})

test('WebGL2 fallback runs the same shaders and matches the WebGPU output', async ({ page }) => {
  await page.goto('/?sr=webgl2')
  await importAndOpen(page, 'manga-vol-01.cbz', 'manga-vol-01')
  await page.mouse.move(590, 410)
  await page.getByTestId('settings').click()
  await expect(page.getByTestId('sr-status')).toContainText('WebGL2', { timeout: 30_000 })
  await page.getByTestId('sr-M').click() // deterministic level and factor for the comparison
  await page.getByTestId('scale-x2').click()
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()
  const enhanced = page.locator('[data-testid=page][data-page="1"] canvas[data-testid=enhanced]')
  await expect(enhanced).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('[data-testid=page][data-page="1"]')).toHaveAttribute('data-sr', 'M', { timeout: 45_000 })
  await expect(enhanced).toHaveAttribute('data-sr-width', '1600')
  await page.waitForTimeout(500) // let the high-quality fit replace the quick preview
  const webgl2Png = await page.evaluate(() => {
    const c = document.querySelector('[data-testid=page][data-page="1"] canvas') as HTMLCanvasElement
    const copy = document.createElement('canvas')
    copy.width = c.width
    copy.height = c.height
    copy.getContext('2d')!.drawImage(c, 0, 0)
    return copy.toDataURL('image/png')
  })

  // The heaviest level (25 fragment programs) compiles and runs on WebGL2 too.
  await page.mouse.move(600, 420)
  await page.getByTestId('settings').click()
  await page.getByTestId('sr-UL').click()
  await expect(page.locator('[data-testid=page][data-page="1"]')).toHaveAttribute('data-sr', 'UL', { timeout: 60_000 })
  await page.getByTestId('sr-M').click()
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()

  const hasWebGPU = await page.evaluate(async () => !!(navigator as Navigator & { gpu?: GPU }).gpu && !!(await (navigator as Navigator & { gpu?: GPU }).gpu!.requestAdapter()))
  test.skip(!hasWebGPU, 'WebGPU needed for the cross-backend comparison')

  await page.goto('/?sr=webgpu')
  await page.getByRole('button', { name: 'Apri manga-vol-01' }).click()
  await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
  await expect(page.locator('[data-testid=page][data-page="1"]')).toHaveAttribute('data-sr', 'M', { timeout: 45_000 })
  await expect(page.locator('[data-testid=page][data-page="1"] canvas[data-testid=enhanced]')).toHaveAttribute('data-sr-width', '1600')
  await page.waitForTimeout(500)
  const psnr = await page.evaluate(async (dataUrl: string) => {
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const a = document.createElement('canvas')
    a.width = img.naturalWidth
    a.height = img.naturalHeight
    const actx = a.getContext('2d')!
    actx.drawImage(img, 0, 0)
    const ref = actx.getImageData(0, 0, a.width, a.height).data
    const c = document.querySelector('[data-testid=page][data-page="1"] canvas') as HTMLCanvasElement
    const b = document.createElement('canvas')
    b.width = c.width
    b.height = c.height
    const bctx = b.getContext('2d')!
    bctx.drawImage(c, 0, 0)
    const out = bctx.getImageData(0, 0, b.width, b.height).data
    if (a.width !== b.width || a.height !== b.height) return -1
    let se = 0
    let maxDiff = 0
    for (let i = 0; i < ref.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        const d = ref[i + k]! - out[i + k]!
        se += d * d
        if (Math.abs(d) > maxDiff) maxDiff = Math.abs(d)
      }
    }
    const mse = se / ((ref.length / 4) * 3)
    return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
  }, webgl2Png)
  console.log(`WebGL2 vs WebGPU (level M): ${psnr.toFixed(1)} dB`)
  expect(psnr).toBeGreaterThan(40)
})

test('Qualità massima: Real-ESRGAN x4 batch job, results win over Anime4K and survive a reload', async ({ page }) => {
  test.setTimeout(15 * 60_000)
  await page.goto('/')
  await importAndOpen(page, 'tiny-book.cbz', 'tiny-book')
  await page.mouse.move(590, 410)
  await page.getByTestId('settings').click()
  await expect(page.getByTestId('mq-status')).toContainText('Disattivata')
  // The preference stays checked, but its engine and controls are disabled while the heavy tier
  // is active: only one enhanced/plain swap can happen.
  await expect(page.getByRole('switch', { name: 'Super risoluzione' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('switch', { name: 'Qualità massima' }).click()
  await expect(page.getByTestId('sr-section').locator('..')).toHaveAttribute('aria-disabled', 'true')
  const status = page.getByTestId('mq-status')
  await expect(status).not.toContainText('Caricamento', { timeout: 180_000 })
  const text = (await status.textContent()) ?? ''
  test.skip(text.includes('non disponibile su questo server'), 'GAN model not fetched (npm run setup)')
  expect(text).toMatch(/Real-ESRGAN anime 6B \(GAN\) ×4 · (WebGPU|CPU)/)
  const hasShaderF16 = await page.evaluate(async () => {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
    return !!gpu && (await gpu.requestAdapter({ powerPreference: 'high-performance' }))?.features.has('shader-f16') === true
  })
  if (text.includes('WebGPU') && hasShaderF16) expect(text).toContain('WebGPU FP16 · graph capture')
  console.log('GAN:', text)

  await page.getByTestId('mq-start').click()
  await expect(page.getByTestId('mq-cancel')).toBeVisible()
  await expect(page.getByText(/^Completato: 2 pagine in cache\./)).toBeVisible({ timeout: 12 * 60_000 })
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()

  const p1 = page.locator('[data-testid=page][data-page="1"]')
  await expect(p1).toHaveAttribute('data-sr', 'GAN', { timeout: 30_000 })
  // Native x4 output (300 px pages -> 1200), fitted to the box.
  await expect(p1.locator('canvas[data-testid=enhanced]')).toHaveAttribute('data-sr-width', '1200')
  await page.mouse.move(600, 420)
  await expect(badge(page)).toHaveAttribute('data-sr-state', 'applied')
  await expect(badge(page)).toHaveAttribute('aria-label', /SR ×4 GAN$/)

  // Sanity: not blank, not garbage (has both dark and light pixels).
  const stats = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid=page][data-page="1"] canvas') as HTMLCanvasElement
    const c = document.createElement('canvas')
    c.width = canvas.width / 2
    c.height = canvas.height / 2
    const ctx = c.getContext('2d')!
    ctx.drawImage(canvas, 0, 0, c.width, c.height)
    const a = ctx.getImageData(0, 0, c.width, c.height).data
    let dark = 0
    let light = 0
    for (let i = 0; i < a.length; i += 4) {
      const l = 0.299 * a[i]! + 0.587 * a[i + 1]! + 0.114 * a[i + 2]!
      if (l < 80) dark++
      if (l > 200) light++
    }
    return { dark, light, total: a.length / 4 }
  })
  expect(stats.dark).toBeGreaterThan(stats.total * 0.02)
  expect(stats.light).toBeGreaterThan(stats.total * 0.3)

  // Cached results are served after a reload without recomputing.
  await page.reload()
  await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
  await expect(page.locator('[data-testid=page][data-page="1"]')).toHaveAttribute('data-sr', 'GAN', { timeout: 15_000 })
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('[data-testid=page][data-page="2"]')).toHaveAttribute('data-sr', 'GAN', { timeout: 15_000 })
})

test('GAN requeues pruned pages and reveals a double spread atomically', async ({ page }) => {
  test.setTimeout(5 * 60_000)
  await page.goto('/')
  await importAndOpen(page, 'tiny-queue.cbz', 'tiny-queue')
  await page.mouse.move(590, 410)
  await page.getByTestId('settings').click()
  await page.getByRole('switch', { name: 'Qualità massima' }).click()
  const status = page.getByTestId('mq-status')
  await expect(status).not.toContainText('Caricamento', { timeout: 180_000 })
  const statusText = (await status.textContent()) ?? ''
  test.skip(!statusText.includes('WebGPU'), 'on-demand queue needs WebGPU')

  // Disabling Anime4K dims controls, not their card/background (the comic must not show through).
  const srWrapper = page.getByTestId('sr-section').locator('..')
  await expect(srWrapper).toHaveCSS('opacity', '1')
  const cardAlpha = await page
    .getByTestId('sr-section')
    .locator('.group-card')
    .evaluate((element) => getComputedStyle(element).backgroundColor)
  expect(cardAlpha).not.toMatch(/rgba\([^)]*,\s*0(?:\.0+)?\)$/)
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()

  // Drop queued read-ahead jobs, then immediately turn onto pages 2-3. Before the fix those
  // dropped Promises stayed in `inflight` forever and these pages could never be requeued.
  await page.keyboard.press('End')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('page-label')).toHaveText('2-3')
  await page.evaluate(() => {
    const state = (window as unknown as { __partialGan?: boolean; __ganObserver?: MutationObserver })
    state.__partialGan = false
    state.__ganObserver = new MutationObserver(() => {
      const pages = [...document.querySelectorAll('[data-testid="page"]')]
      const enhanced = pages.filter((element) => element.getAttribute('data-sr') === 'GAN').length
      if (pages.length === 2 && enhanced === 1) state.__partialGan = true
    })
    state.__ganObserver.observe(document.body, { subtree: true, attributes: true, childList: true })
  })
  const p2 = page.locator('[data-testid=page][data-page="2"]')
  const p3 = page.locator('[data-testid=page][data-page="3"]')
  await expect(p2).toHaveAttribute('data-sr', 'GAN', { timeout: 120_000 })
  await expect(p3).toHaveAttribute('data-sr', 'GAN', { timeout: 120_000 })
  await expect(p2.locator('canvas[data-testid=enhanced]')).toBeVisible()
  await expect(p3.locator('canvas[data-testid=enhanced]')).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { __partialGan?: boolean }).__partialGan)).toBe(false)
  await page.evaluate(() => (window as unknown as { __ganObserver?: MutationObserver }).__ganObserver?.disconnect())
})

test('Qualità massima on the CPU (WebAssembly threads): batch job only', async ({ page }) => {
  test.setTimeout(20 * 60_000)
  await page.goto('/?cunet=wasm')
  await importAndOpen(page, 'tiny-book.cbz', 'tiny-book')
  await page.mouse.move(590, 410)
  await page.getByTestId('settings').click()
  await page.getByRole('switch', { name: 'Qualità massima' }).click()
  const status = page.getByTestId('mq-status')
  await expect(status).not.toContainText('Caricamento', { timeout: 180_000 })
  const text = (await status.textContent()) ?? ''
  test.skip(text.includes('non disponibile su questo server'), 'GAN model not fetched (npm run setup)')
  expect(text).toContain('CPU (WebAssembly')
  const isolated = await page.evaluate(() => crossOriginIsolated)
  console.log('GAN CPU:', text, '| crossOriginIsolated:', isolated)
  if (isolated) expect(text).toMatch(/[2-9] thread|1[0-9] thread/)
  const t0 = Date.now()
  await page.getByTestId('mq-start').click()
  await expect(page.getByText(/^Completato: 2 pagine in cache\./)).toBeVisible({ timeout: 16 * 60_000 })
  console.log(`CPU batch of 2 tiny pages: ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()
  await expect(page.locator('[data-testid=page][data-page="1"]')).toHaveAttribute('data-sr', 'GAN', { timeout: 30_000 })
})

test('factor x4 / x2 / auto, "Linee nitide", "Pulizia scansione"', async ({ page }) => {
  await page.goto('/')
  const hasWebGPU = await page.evaluate(async () => !!(navigator as Navigator & { gpu?: GPU }).gpu && !!(await (navigator as Navigator & { gpu?: GPU }).gpu!.requestAdapter()))
  test.skip(!hasWebGPU, 'needs WebGPU')
  await importAndOpen(page, 'manga-vol-01.cbz', 'manga-vol-01')
  const p1 = page.locator('[data-testid=page][data-page="1"]')
  const enhanced = p1.locator('canvas[data-testid=enhanced]')
  await expect(enhanced).toBeVisible({ timeout: 90_000 })
  // Auto picks x4 for this page (fits the 16 MP cap and the memory budget).
  await expect(enhanced).toHaveAttribute('data-sr-width', '3200', { timeout: 90_000 })

  // x4 explicit: two network passes, output 4x the source (3200 px for an 800 px page).
  await page.mouse.move(600, 420)
  await page.getByTestId('settings').click()
  await page.getByTestId('scale-x4').click()
  await expect(enhanced).toHaveAttribute('data-sr-width', '3200', { timeout: 90_000 })
  await expect(badge(page)).toHaveAttribute('aria-label', /SR ×4 (M|VL|UL)$/)
  await expect(page.getByTestId('sr-status')).toContainText('×4 → 3200×4800 px')
  // x2 fixed: exactly twice the source.
  await page.getByTestId('scale-x2').click()
  await expect(enhanced).toHaveAttribute('data-sr-width', '1600', { timeout: 60_000 })
  await expect(badge(page)).toHaveAttribute('aria-label', /SR ×2 (M|VL|UL)$/)
  await page.getByTestId('scale-auto').click()
  await expect(enhanced).toHaveAttribute('data-sr-width', '3200', { timeout: 60_000 })

  // Restore pass ("Linee nitide"): re-enhanced, badge marks it with "+", output still faithful.
  await page.getByRole('switch', { name: 'Linee nitide' }).click()
  await expect(badge(page)).toHaveAttribute('aria-label', /SR ×4 (M|VL|UL)\+$/, { timeout: 90_000 })
  await expect(enhanced).toBeVisible()
  // Scan clean-up: paper goes to pure white on the (already white) page background.
  await page.getByRole('switch', { name: 'Pulizia scansione' }).click()
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const c = document.querySelector('[data-testid=page][data-page="1"] canvas') as HTMLCanvasElement | null
          if (!c) return null
          const t = document.createElement('canvas')
          t.width = 8
          t.height = 8
          const ctx = t.getContext('2d')!
          // A patch inside the first empty (untoned) panel of page 1: top-right, plain paper.
          ctx.drawImage(c, Math.round(c.width * 0.7), Math.round(c.height * 0.19), 8, 8, 0, 0, 8, 8)
          const d = ctx.getImageData(0, 0, 8, 8).data
          let min = 255
          for (let i = 0; i < d.length; i += 4) min = Math.min(min, d[i]!, d[i + 1]!, d[i + 2]!)
          return min
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(250)
  await page.getByRole('switch', { name: 'Linee nitide' }).click()
  await page.getByRole('switch', { name: 'Pulizia scansione' }).click()
  await expect(badge(page)).toHaveAttribute('aria-label', /SR ×4 (M|VL|UL)$/, { timeout: 90_000 })
})

test('?sr=off disables super resolution entirely', async ({ page }) => {
  await page.goto('/?sr=off')
  await importAndOpen(page, 'short-book.cbz', 'short-book')
  await expect(page.locator('[data-testid=page][data-page="1"] img')).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(page.locator('canvas[data-testid=enhanced]')).toHaveCount(0)
  await page.mouse.move(590, 410)
  await expect(badge(page)).toHaveCount(0)
})
