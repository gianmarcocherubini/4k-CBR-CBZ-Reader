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
  const declineOnline = page.getByRole('button', { name: 'Non ora' })
  if (await declineOnline.isVisible()) await declineOnline.click()
  const keep = page.getByRole('button', { name: 'Mantieni attuale' })
  if (await keep.isVisible()) await keep.click()
  await page.getByRole('button', { name: `Apri ${title}` }).click()
  await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
}

const badge = (page: Page) => page.getByTestId('sr-badge')

/**
 * HD is fully automatic in the UI; the Anime4K parameters survive as stored settings so tests can
 * pin a level or a factor. Settings load at start-up: reload (the reader route is in the hash).
 */
async function presetSettings(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((p) => {
    const key = 'reader.settings.v1'
    const current = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>
    localStorage.setItem(key, JSON.stringify({ ...current, ...p }))
  }, patch)
  await page.reload()
  await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
}

/**
 * Luma of an <img> or <canvas> resampled to `w` x `h` (the source page's own resolution), as a
 * base64 byte string small enough to hand back to Node and compare across navigations.
 */
async function pageLuma(page: Page, selector: string, w: number, h: number): Promise<Uint8Array> {
  const b64 = await page.evaluate(
    async ({ selector, w, h }) => {
      const el = document.querySelector(selector) as HTMLImageElement | HTMLCanvasElement
      if (el instanceof HTMLImageElement) await el.decode()
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')!
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(el, 0, 0, w, h)
      const d = ctx.getImageData(0, 0, w, h).data
      const out = new Uint8Array(w * h)
      for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = Math.round(0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!)
      let s = ''
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000))
      return btoa(s)
    },
    { selector, w, h },
  )
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}

function psnrOf(a: Uint8Array, b: Uint8Array): number {
  let se = 0
  for (let i = 0; i < a.length; i++) se += (a[i]! - b[i]!) ** 2
  const mse = se / a.length
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
}

/**
 * Width the engine renders on "Auto": a fixed factor of the source, independent of the display.
 * x4 when the result stays within the 16 MP canvas cap (800x1200 -> 3200), else x2 (1000x1500 -> 2000).
 */
function autoWidth(srcW: number, srcH: number): number {
  return srcW * srcH * 16 <= 16 * 1024 * 1024 ? srcW * 4 : srcW * 2
}

test('Anime4K super resolution: enhanced canvas, badge, level probe, faithful output (or clean fallback)', async ({ page }) => {
  test.setTimeout(4 * 60_000) // a dozen GPU passes: minutes on the software renderer of CI
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
  // The HD tier has no knobs: level, factor, restore and clean-up are gone from the sheet.
  await expect(page.getByTestId('res-hd')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('scale-x2')).toHaveCount(0)
  await expect(page.getByTestId('sr-M')).toHaveCount(0)
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()

  // Faithfulness: the exact 2x output downsampled back must match the source closely (no strip
  // misalignment, no colour drift). The source comes from the same book with SR disabled.
  const readerUrl = page.url()
  await page.goto(readerUrl.replace(/\?[^#]*/, '').replace('#', '?sr=off#'))
  await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
  const img = page.locator('[data-testid=page][data-page="1"] img')
  await expect(img).toBeVisible()
  const source = await pageLuma(page, '[data-testid=page][data-page="1"] img', 800, 1200)
  await page.goto(readerUrl)
  await presetSettings(page, { srScale: 'x2' })
  await expect(enhanced).toBeVisible({ timeout: 90_000 })
  await expect(enhanced).toHaveAttribute('data-sr-width', '1600', { timeout: 90_000 })
  await expect(page.locator('[data-testid=page][data-page="1"]')).toHaveAttribute('data-sr', /^(M|VL|UL)$/, { timeout: 90_000 })
  await page.waitForTimeout(500) // let the high-quality fit replace the quick preview
  const psnr = psnrOf(source, await pageLuma(page, '[data-testid=page][data-page="1"] canvas', 800, 1200))
  console.log(`downsampled enhanced vs source: ${psnr.toFixed(1)} dB (level ${level})`)
  expect(psnr).toBeGreaterThan(28)

  // A pinned level is honoured.
  await presetSettings(page, { srScale: 'auto', srLevel: 'M' })
  await expect(page.locator('[data-testid=page][data-page="1"]')).toHaveAttribute('data-sr', 'M', { timeout: 90_000 })

  // Turning the page enhances the new spread on demand (no read-ahead).
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
  await expect(mini).toHaveAttribute('aria-label', /HD ×4 M/)
  // Hidden while the toolbars (with the full badge) are visible, and when switched off.
  await page.mouse.move(640, 450)
  await expect(mini).toHaveCount(0)
  await page.mouse.move(600, 420)
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
  await expect(badge(page)).toHaveAttribute('aria-label', /HD ×2 (M|VL|UL)$/, { timeout: 60_000 })
  const before = await enhanced.evaluate((c: HTMLCanvasElement) => c.width)
  // Zooming in does not recompute anything: same result, refitted at the larger displayed size.
  await page.mouse.dblclick(590, 410)
  await expect.poll(() => enhanced.evaluate((c: HTMLCanvasElement) => c.width), { timeout: 5_000 }).toBeGreaterThan(before)
  await expect(enhanced).toHaveAttribute('data-sr-width', String(autoWidth(1000, 1500)))
  await expect(badge(page)).toHaveAttribute('aria-label', /HD ×2 (M|VL|UL)$/)
})

test('WebGL2 fallback runs the same shaders and matches the WebGPU output', async ({ page }) => {
  test.setTimeout(4 * 60_000)
  await page.goto('/?sr=webgl2')
  // Deterministic level and factor for the comparison (pinned through the stored settings).
  await page.evaluate(() => localStorage.setItem('reader.settings.v1', JSON.stringify({ srLevel: 'M', srScale: 'x2' })))
  await page.reload()
  await importAndOpen(page, 'manga-vol-01.cbz', 'manga-vol-01')
  await page.mouse.move(590, 410)
  await page.getByTestId('settings').click()
  await expect(page.getByTestId('sr-status')).toContainText('WebGL2', { timeout: 30_000 })
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
  await presetSettings(page, { srLevel: 'UL' })
  await expect(page.locator('[data-testid=page][data-page="1"]')).toHaveAttribute('data-sr', 'UL', { timeout: 90_000 })
  await presetSettings(page, { srLevel: 'M' })

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

test('Real-ESRGAN WebGPU kernels match the float32 reference, band seams included', async ({ page }) => {
  test.setTimeout(25 * 60_000)
  await page.goto('/?test')
  const hasWebGPU = await page.evaluate(async () => !!(navigator as Navigator & { gpu?: GPU }).gpu && !!(await (navigator as Navigator & { gpu?: GPU }).gpu!.requestAdapter()))
  test.skip(!hasWebGPU, 'needs WebGPU')
  type Hooks = {
    __reader?: {
      esrganSelfTest: (o: {
        width: number
        height: number
        smallBands?: boolean
        ensemble?: 1 | 2 | 4 | 8
        model?: 'v3' | '6b'
        gpuReference?: boolean
        variant?: 1 | 2 | 'w'
      }) => Promise<SelfTest>
    }
  }
  type SelfTest = { precision: 'f16' | 'f32'; bands: number; x4: { psnr: number; maxDiff: number }; x2: { psnr: number; maxDiff: number } }
  await page.waitForFunction(() => !!(window as unknown as Hooks).__reader)
  // A 40x56 image cut into 8-row bands: every seam of the tiled path is exercised.
  const result = await page.evaluate(() => (window as unknown as Hooks).__reader!.esrganSelfTest({ width: 40, height: 56, smallBands: true }))
  console.log('Real-ESRGAN self-test:', JSON.stringify(result))
  expect(result.bands).toBeGreaterThan(1)
  // f32 kernels reproduce the reference to the rounding bit; f16 storage/arithmetic stays visually identical.
  const minPsnr = result.precision === 'f16' ? 38 : 60
  const maxDiff = result.precision === 'f16' ? 12 : 2
  expect(result.x4.psnr).toBeGreaterThan(minPsnr)
  expect(result.x4.maxDiff).toBeLessThanOrEqual(maxDiff)
  expect(result.x2.psnr).toBeGreaterThan(minPsnr)
  expect(result.x2.maxDiff).toBeLessThanOrEqual(maxDiff)

  // Self-ensemble: the GPU averages the passes over transformed copies exactly like the CPU does
  // (the CPU rounds each pass to 8 bits first, hence the looser bound).
  const ensemble = await page.evaluate(() => (window as unknown as Hooks).__reader!.esrganSelfTest({ width: 40, height: 56, smallBands: true, ensemble: 2 }))
  console.log('Real-ESRGAN ensemble self-test:', JSON.stringify(ensemble))
  expect(ensemble.x4.psnr).toBeGreaterThan(result.precision === 'f16' ? 38 : 50)
  expect(ensemble.x4.maxDiff).toBeLessThanOrEqual(result.precision === 'f16' ? 12 : 2)
  expect(ensemble.x2.maxDiff).toBeLessThanOrEqual(result.precision === 'f16' ? 12 : 2)

  // Winograd F(2x2, 3x3) kernels (input transform, shared-memory multiply, fused output transform)
  // on the same bands: the same maths through transforms, exact to f32 rounding.
  const wino = await page.evaluate(() => (window as unknown as Hooks).__reader!.esrganSelfTest({ width: 40, height: 56, smallBands: true, variant: 'w' }))
  console.log('Real-ESRGAN Winograd self-test:', JSON.stringify(wino))
  expect(wino.x4.psnr).toBeGreaterThan(result.precision === 'f16' ? 38 : 60)
  expect(wino.x4.maxDiff).toBeLessThanOrEqual(result.precision === 'f16' ? 12 : 1)
  expect(wino.x2.maxDiff).toBeLessThanOrEqual(result.precision === 'f16' ? 12 : 1)

  // The 6-block RRDB network (dense blocks, residual scaling, nearest-upsample tail on strips): one
  // band of a 16x12 image reproduces the CPU reference to the bit in f32.
  const rrdb = await page.evaluate(() => (window as unknown as Hooks).__reader!.esrganSelfTest({ width: 16, height: 12, model: '6b' }))
  console.log('Real-ESRGAN 6B self-test:', JSON.stringify(rrdb))
  expect(rrdb.x4.psnr).toBeGreaterThan(result.precision === 'f16' ? 38 : 60)
  expect(rrdb.x4.maxDiff).toBeLessThanOrEqual(result.precision === 'f16' ? 12 : 1)
  expect(rrdb.x2.maxDiff).toBeLessThanOrEqual(result.precision === 'f16' ? 12 : 1)

  // Winograd on the 6B: dense concatenations, residual epilogues and the upsampling tail, bit-exact in f32.
  const rrdbWino = await page.evaluate(() => (window as unknown as Hooks).__reader!.esrganSelfTest({ width: 16, height: 12, model: '6b', variant: 'w' }))
  console.log('Real-ESRGAN 6B Winograd self-test:', JSON.stringify(rrdbWino))
  expect(rrdbWino.x4.psnr).toBeGreaterThan(result.precision === 'f16' ? 38 : 60)
  expect(rrdbWino.x4.maxDiff).toBeLessThanOrEqual(result.precision === 'f16' ? 12 : 1)
  expect(rrdbWino.x2.maxDiff).toBeLessThanOrEqual(result.precision === 'f16' ? 12 : 1)

  // 6B self-ensemble with all eight symmetries (transposed passes included) over three bands, the
  // last one shorter: compared with the GPU's own single passes mapped back and averaged.
  const rrdbEnsemble = await page.evaluate(() =>
    (window as unknown as Hooks).__reader!.esrganSelfTest({ width: 16, height: 24, model: '6b', ensemble: 8, smallBands: true, gpuReference: true }),
  )
  console.log('Real-ESRGAN 6B ensemble self-test:', JSON.stringify(rrdbEnsemble))
  expect(rrdbEnsemble.bands).toBeGreaterThan(1)
  expect(rrdbEnsemble.x4.psnr).toBeGreaterThan(result.precision === 'f16' ? 38 : 50)
  expect(rrdbEnsemble.x4.maxDiff).toBeLessThanOrEqual(result.precision === 'f16' ? 12 : 2)
  expect(rrdbEnsemble.x2.maxDiff).toBeLessThanOrEqual(result.precision === 'f16' ? 12 : 2)
})

test('Qualità massima: Real-ESRGAN x4 on the visible page only, time budget falls back to Anime4K', async ({ page }) => {
  test.setTimeout(15 * 60_000)
  await page.goto('/')
  const hasWebGPU = await page.evaluate(async () => !!(navigator as Navigator & { gpu?: GPU }).gpu && !!(await (navigator as Navigator & { gpu?: GPU }).gpu!.requestAdapter()))
  test.skip(!hasWebGPU, 'needs WebGPU')
  await importAndOpen(page, 'tiny-book.cbz', 'tiny-book')
  await page.mouse.move(590, 410)
  await page.getByTestId('settings').click()
  // One quality choice: HD (automatic) or 4K with a rendering speed ordered by quality.
  await expect(page.getByTestId('res-hd')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('rend-fast')).toHaveCount(0)
  await page.getByTestId('res-4k').click()
  await expect(page.getByTestId('rend-fast')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('rend-medium')).toBeVisible()
  await expect(page.getByTestId('rend-slow')).toContainText('massima')
  await expect(page.getByRole('switch', { name: 'Sfocatura anti-spoiler' })).toHaveAttribute('aria-checked', 'true')
  const status = page.getByTestId('mq-status')
  await expect(status).not.toContainText('Inizializzazione', { timeout: 5 * 60_000 })
  const text = (await status.textContent()) ?? ''
  console.log('4K:', text)
  expect(text).toMatch(/^Fast · Real-ESRGAN anime v3 ×4 · WebGPU F(16|32) · kernel (4×[12]|Winograd)/)
  expect(text).toMatch(/stimati [\d.]+ s per la pagina/)
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()

  const p1 = page.locator('[data-testid=page][data-page="1"]')
  // Anti-spoiler: the plain page is blurred while its HD version is being computed.
  await expect(p1).toHaveAttribute('data-blurred', 'true', { timeout: 60_000 })
  await expect(p1.locator('img')).toHaveClass(/antispoiler/)
  await expect(p1).toHaveAttribute('data-sr', 'GAN', { timeout: 8 * 60_000 })
  await expect(p1).not.toHaveAttribute('data-blurred', 'true')
  // Native x4 output (300 px pages -> 1200), fitted to the box.
  await expect(p1.locator('canvas[data-testid=enhanced]')).toHaveAttribute('data-sr-width', '1200')
  await page.mouse.move(600, 420)
  await expect(badge(page)).toHaveAttribute('data-sr-state', 'applied')
  await expect(badge(page)).toHaveAttribute('aria-label', /4K ×4 v3$/)
  await expect(badge(page)).toHaveText('4K')

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

  // Going back to an already processed page is instant (in-memory LRU), the next one is computed on demand.
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('page-label')).toHaveText('2')
  await expect(page.locator('[data-testid=page][data-page="2"]')).toHaveAttribute('data-sr', 'GAN', { timeout: 8 * 60_000 })
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('page-label')).toHaveText('1')
  await expect(p1).toHaveAttribute('data-sr', 'GAN', { timeout: 5_000 })

  // The kernel benchmark's outcome is remembered for this device and app version.
  const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem('reader.esrgan-kernel.v1') ?? '{}') as Record<string, { variant: unknown }>)
  const choices = Object.values(remembered)
  expect(choices).toHaveLength(1)
  expect([1, 2, 'w']).toContain(choices[0]!.variant)

  // Sanity cap: a spread predicted to take far too long stays in HD (the cap is lowered to 1 s
  // through a test flag; the software renderer of CI predicts more than that).
  const estimated = Number(/stimati ([\d.]+) s/.exec(text)?.[1] ?? '0')
  const readerUrl = page.url()
  await page.goto(readerUrl.replace('#', '?mqcap=1000#'))
  await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
  await page.keyboard.press('Home') // the bookmark may still hold the previous spread
  await expect(page.getByTestId('page-label')).toHaveText('1')
  if (estimated > 1) {
    await expect(p1).toHaveAttribute('data-sr', /^(M|VL|UL)$/, { timeout: 90_000 })
    await page.mouse.move(600, 420)
    await expect(badge(page)).toHaveAttribute('aria-label', /HD ×(2|4) (M|VL|UL)$/)
    await page.getByTestId('settings').click()
    await expect(page.getByTestId('mq-status')).toContainText('restano in HD', { timeout: 5 * 60_000 })
  } else {
    await expect(p1).toHaveAttribute('data-sr', 'GAN', { timeout: 8 * 60_000 })
  }
})

test('HD in double page: both pages turn enhanced in the same frame, never one before the other', async ({ page }) => {
  test.setTimeout(6 * 60_000)
  await page.goto('/')
  const hasWebGPU = await page.evaluate(async () => !!(navigator as Navigator & { gpu?: GPU }).gpu && !!(await (navigator as Navigator & { gpu?: GPU }).gpu!.requestAdapter()))
  test.skip(!hasWebGPU, 'needs WebGPU')
  await importAndOpen(page, 'manga-vol-01.cbz', 'manga-vol-01')
  // The cover alone first: its enhancement builds the pipeline and settles the level.
  await expect(page.locator('[data-testid=page][data-page="1"] canvas[data-testid=enhanced]')).toBeVisible({ timeout: 90_000 })
  await page.mouse.move(600, 420)
  await expect(badge(page)).toHaveAttribute('data-sr-state', 'applied', { timeout: 90_000 })

  // Record, for every page box, when its enhanced canvas appears (both pages of 2-3 start plain).
  await page.evaluate(() => {
    const seen: Record<string, number> = {}
    ;(window as unknown as { __hdSeen: Record<string, number> }).__hdSeen = seen
    new MutationObserver(() => {
      for (const c of document.querySelectorAll('[data-testid=page] canvas[data-testid=enhanced]')) {
        const n = c.closest('[data-testid=page]')?.getAttribute('data-page')
        if (n && !(n in seen)) seen[n] = performance.now()
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('page-label')).toHaveText('2-3')
  await expect(page.locator('[data-testid=page][data-page="2"] canvas[data-testid=enhanced]')).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('[data-testid=page][data-page="3"] canvas[data-testid=enhanced]')).toBeVisible({ timeout: 90_000 })
  const seen = await page.evaluate(() => (window as unknown as { __hdSeen: Record<string, number> }).__hdSeen)
  expect(seen['2']).toBeDefined()
  expect(seen['3']).toBeDefined()
  // One commit for the whole spread: the two canvases enter the DOM in the same mutation batch.
  expect(Math.abs(seen['2']! - seen['3']!)).toBeLessThan(20)
})

test('Anime4K engine options (factor, Restore, clean-up) still work when pinned through the stored settings', async ({ page }) => {
  test.setTimeout(6 * 60_000)
  await page.goto('/')
  const hasWebGPU = await page.evaluate(async () => !!(navigator as Navigator & { gpu?: GPU }).gpu && !!(await (navigator as Navigator & { gpu?: GPU }).gpu!.requestAdapter()))
  test.skip(!hasWebGPU, 'needs WebGPU')
  await importAndOpen(page, 'manga-vol-01.cbz', 'manga-vol-01')
  const p1 = page.locator('[data-testid=page][data-page="1"]')
  const enhanced = p1.locator('canvas[data-testid=enhanced]')
  await expect(enhanced).toBeVisible({ timeout: 90_000 })
  // Auto picks x4 for this page (fits the 16 MP cap and the memory budget).
  await expect(enhanced).toHaveAttribute('data-sr-width', '3200', { timeout: 90_000 })
  await page.mouse.move(600, 420)
  await expect(badge(page)).toHaveAttribute('aria-label', /HD ×4 (M|VL|UL)$/, { timeout: 90_000 })
  await page.getByTestId('settings').click()
  await expect(page.getByTestId('sr-status')).toContainText('×4 → 3200×4800 px')
  await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()

  // x2 fixed: exactly twice the source.
  await presetSettings(page, { srScale: 'x2' })
  await expect(enhanced).toHaveAttribute('data-sr-width', '1600', { timeout: 90_000 })
  await page.mouse.move(600, 420)
  await expect(badge(page)).toHaveAttribute('aria-label', /HD ×2 (M|VL|UL)$/, { timeout: 90_000 })

  // Restore pass: the badge marks it with "+"; clean-up: paper goes to pure white.
  await presetSettings(page, { srScale: 'auto', srRestore: true, srClean: true })
  await page.mouse.move(600, 420)
  await expect(badge(page)).toHaveAttribute('aria-label', /HD ×4 (M|VL|UL)\+$/, { timeout: 120_000 })
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
