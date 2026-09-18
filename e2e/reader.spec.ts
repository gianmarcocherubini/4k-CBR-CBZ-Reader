import { expect, type Page, test } from '@playwright/test'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const fx = (name: string) => join(fixtures, name)
const PREVIEW = process.env.E2E_PREVIEW === '1'

// Stage geometry for the 1180x820 viewport: left/right 30% are tap zones.
const LEFT = { x: 120, y: 410 }
const RIGHT = { x: 1060, y: 410 }
const CENTER = { x: 590, y: 410 }

test.beforeAll(() => {
  if (!existsSync(fx('manga-vol-01.cbz'))) execSync('node scripts/make-fixtures.mjs', { cwd: join(here, '..'), stdio: 'inherit' })
})

async function importBooks(page: Page, names: string[]) {
  await page.setInputFiles('[data-testid=import-input]', names.map(fx))
  const overlay = page.getByTestId('import-overlay')
  await expect(overlay.getByText('Importazione completata')).toBeVisible({ timeout: 30_000 })
  const statuses = await overlay.getByTestId('import-status').allTextContents()
  await overlay.getByTestId('import-close').click()
  return statuses
}

async function openBook(page: Page, title: string) {
  await page.getByRole('button', { name: `Apri ${title}` }).click()
  await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
}

const label = (page: Page) => page.getByTestId('page-label')
const pageBox = async (page: Page, n: number) => {
  // Geometry is measured once the page-turn animation has finished.
  await expect(page.getByTestId('spread-ghost')).toHaveCount(0)
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle'))
  const box = await page.locator(`[data-testid=page][data-page="${n}"]`).boundingBox()
  expect(box, `page ${n} should be on screen`).not.toBeNull()
  return box!
}

test.describe('library', () => {
  test('imports a batch, reports errors in Italian and shows covers', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('empty-library')).toBeVisible()
    const statuses = await importBooks(page, [
      'manga-vol-01.cbz',
      'short-book.cbz',
      'zip64-book.cbz',
      'no-images.cbz',
      'corrupt.cbz',
      'archive.7z',
    ])
    expect(statuses.slice(0, 3)).toEqual(['Importato', 'Importato', 'Importato'])
    expect(statuses[3]).toContain('non contiene immagini')
    expect(statuses[4]).toContain('danneggiato')
    expect(statuses[5]).toContain('non è un archivio CBZ')

    await expect(page.getByTestId('book-card')).toHaveCount(3)
    await expect(page.locator('[data-testid=book-card] img')).toHaveCount(3)
    await expect(page.getByTestId('storage-footer')).toContainText('Spazio usato')
    await expect(page.getByText('3 nella libreria')).toBeVisible()

    // Re-importing the same file is refused as a duplicate.
    const again = await importBooks(page, ['short-book.cbz'])
    expect(again[0]).toContain('già nella libreria')
    await expect(page.getByTestId('book-card')).toHaveCount(3)
  })

  test('imports a password-protected ZIP, retries a wrong password and keeps it in memory only', async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('[data-testid=import-input]', fx('protected.zip'))
    const password = page.getByTestId('password-dialog')
    await expect(password).toBeVisible()
    await password.getByLabel('Password dell’archivio').fill('sbagliata')
    await password.getByRole('button', { name: 'Sblocca' }).click()
    await expect(password.getByRole('heading')).toHaveText('Password non corretta')
    await password.getByLabel('Password dell’archivio').fill('segreto')
    await password.getByRole('button', { name: 'Sblocca' }).click()

    const overlay = page.getByTestId('import-overlay')
    await expect(overlay.getByText('Importazione completata')).toBeVisible({ timeout: 30_000 })
    await expect(overlay.getByTestId('import-status')).toHaveText('Importato')
    await overlay.getByTestId('import-close').click()
    const stored = await page.evaluate(
      () =>
        new Promise<{ passwordProtected: boolean; hasPassword: boolean; hasCover: boolean }>((resolve, reject) => {
          const request = indexedDB.open('cbz-reader')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const get = request.result.transaction('books').objectStore('books').getAll()
            get.onerror = () => reject(get.error)
            get.onsuccess = () => {
              const book = get.result[0] as Record<string, unknown>
              resolve({
                passwordProtected: book.passwordProtected === true,
                hasPassword: Object.hasOwn(book, 'archivePassword'),
                hasCover: book.cover instanceof Blob,
              })
            }
          }
        }),
    )
    expect(stored).toEqual({ passwordProtected: true, hasPassword: false, hasCover: false })
    await openBook(page, 'protected')
    await expect(page.locator('[data-testid=page][data-page="1"] img')).toBeVisible()

    // A reload deliberately forgets the password; the encrypted file remains, decrypted data does not.
    await page.getByTestId('back').click()
    await page.reload()
    await page.getByRole('button', { name: 'Apri protected' }).click()
    await expect(page.getByTestId('password-dialog')).toBeVisible()
    await page.getByLabel('Password dell’archivio').fill('segreto')
    await page.getByRole('button', { name: 'Sblocca' }).click()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
    await expect(page.locator('[data-testid=page][data-page="1"] img')).toBeVisible()
  })

  test('deletes a book together with its data', async ({ page }) => {
    await page.goto('/')
    await importBooks(page, ['short-book.cbz'])
    await expect(page.getByTestId('book-card')).toHaveCount(1)
    await page.getByRole('button', { name: 'Elimina short-book' }).click()
    await page.getByTestId('confirm-delete').click()
    await expect(page.getByTestId('empty-library')).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('empty-library')).toBeVisible()
  })

  test('falls back to IndexedDB storage when forced (?storage=idb)', async ({ page }) => {
    await page.goto('/?storage=idb')
    await importBooks(page, ['zip64-book.cbz'])
    await openBook(page, 'zip64-book')
    await expect(label(page)).toHaveText('1')
    await page.keyboard.press('End')
    await expect(label(page)).toHaveText('4')
    await expect(page.locator('[data-testid=page][data-page="4"] img')).toBeVisible()
  })

  test('orphan cleanup never deletes a file protected by an import lock in another tab', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(async () => {
      let release!: () => void
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      ;(window as unknown as { __releaseImportLock: () => void }).__releaseImportLock = release
      void navigator.locks.request('reader:opfs-import:locked-import', async () => {
        const root = await navigator.storage.getDirectory()
        const books = await root.getDirectoryHandle('books', { create: true })
        await books.getFileHandle('locked-import', { create: true })
        ;(window as unknown as { __importLockHeld: boolean }).__importLockHeld = true
        await hold
      })
    })
    await expect.poll(() => page.evaluate(() => (window as unknown as { __importLockHeld?: boolean }).__importLockHeld)).toBe(true)

    const other = await page.context().newPage()
    await other.goto('/')
    await expect(other.getByTestId('empty-library')).toBeVisible()
    const exists = () =>
      other.evaluate(async () => {
        try {
          const root = await navigator.storage.getDirectory()
          const books = await root.getDirectoryHandle('books')
          await books.getFileHandle('locked-import')
          return true
        } catch {
          return false
        }
      })
    await expect.poll(exists).toBe(true)

    await page.evaluate(() => (window as unknown as { __releaseImportLock: () => void }).__releaseImportLock())
    await other.reload()
    await expect(other.getByTestId('empty-library')).toBeVisible()
    await expect.poll(exists).toBe(false)
    await other.close()
  })

  test('"Apri senza importare" reads the file directly and leaves the library untouched', async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('[data-testid=session-input]', fx('short-book.cbz'))
    await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
    await expect(label(page)).toHaveText('1')
    await page.mouse.click(LEFT.x, LEFT.y)
    await expect(label(page)).toHaveText('2-3')
    await page.getByTestId('back').click()
    await expect(page.getByTestId('book-card')).toHaveCount(1)
    await expect(page.getByText('Sessione')).toBeVisible()
    await expect(page.getByText('0 nella libreria')).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('empty-library')).toBeVisible()
  })
})

test.describe('reader', () => {
  test('RTL smart double page: pairing, wide spread alone, offset toggle, single mode', async ({ page }) => {
    await page.goto('/')
    await importBooks(page, ['manga-vol-01.cbz'])
    await openBook(page, 'manga-vol-01')
    const lbl = label(page)
    await expect(lbl).toHaveText('1')
    await expect(page.locator('[data-testid=page][data-page="1"] img')).toBeVisible()

    // Tap on the left = next page in RTL. Page 2 is displayed to the RIGHT of page 3.
    await page.mouse.click(LEFT.x, LEFT.y)
    await expect(lbl).toHaveText('2-3')
    const b2 = await pageBox(page, 2)
    const b3 = await pageBox(page, 3)
    expect(b2.x).toBeGreaterThan(b3.x)
    // Default centre margin ("Medio", 3% of the page height, white) separates the two pages.
    const gutter = (await page.getByTestId('gutter').boundingBox())!
    expect(gutter.width).toBeCloseTo(b3.height * 0.03, 0)
    expect(gutter.x).toBeCloseTo(b3.x + b3.width, 0)
    expect(b2.x).toBeCloseTo(gutter.x + gutter.width, 0)
    await expect(page.getByTestId('gutter')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    // "Nessuno" makes the pages touch again.
    await page.mouse.move(CENTER.x, CENTER.y)
    await page.getByTestId('settings').click()
    await page.getByTestId('gutter-none').click()
    await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()
    await expect(page.getByTestId('gutter')).toHaveCount(0)
    const b2b = await pageBox(page, 2)
    const b3b = await pageBox(page, 3)
    expect(Math.abs(b2b.x - (b3b.x + b3b.width))).toBeLessThan(2)
    await page.mouse.move(CENTER.x, CENTER.y)
    await page.getByTestId('settings').click()
    await page.getByTestId('gutter-m').click()
    await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()
    await expect(page.getByTestId('gutter')).toBeVisible()

    for (const expected of ['4-5', '6-7', '8-9', '10-11', '12']) {
      await page.mouse.click(LEFT.x, LEFT.y)
      await expect(lbl).toHaveText(expected)
    }
    // The wide page (12) stands alone and is landscape on screen; pairing resumes with 13-14.
    const b12 = await pageBox(page, 12)
    expect(b12.width).toBeGreaterThan(b12.height)
    await expect(page.locator('[data-testid=page]')).toHaveCount(1)
    await page.mouse.click(LEFT.x, LEFT.y)
    await expect(lbl).toHaveText('13-14')

    // Tap on the right = previous.
    await page.mouse.click(RIGHT.x, RIGHT.y)
    await expect(lbl).toHaveText('12')

    // Keyboard.
    await page.keyboard.press('End')
    await expect(lbl).toHaveText('19')
    await page.keyboard.press('Home')
    await expect(lbl).toHaveText('1')
    await page.keyboard.press('ArrowLeft')
    await expect(lbl).toHaveText('2-3')
    await page.keyboard.press('ArrowRight')
    await expect(lbl).toHaveText('1')

    // Offset (from Settings → "Sfasa coppie"): cover paired with page 2, and back.
    await page.mouse.move(CENTER.x, CENTER.y) // reveal toolbars
    await page.getByTestId('settings').click()
    await page.getByRole('switch', { name: 'Sfasa coppie' }).click()
    await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()
    await expect(lbl).toHaveText('1-2')
    await page.mouse.move(CENTER.x, CENTER.y)
    await page.getByTestId('settings').click()
    await page.getByRole('switch', { name: 'Sfasa coppie' }).click()
    await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()
    await expect(lbl).toHaveText('1')

    // Single page mode.
    await page.getByTestId('toggle-double').click()
    await expect(lbl).toHaveText('1')
    await page.mouse.click(LEFT.x, LEFT.y)
    await expect(lbl).toHaveText('2')
    await expect(page.locator('[data-testid=page]')).toHaveCount(1)
    await page.mouse.move(CENTER.x, CENTER.y)
    await page.getByTestId('toggle-double').click()
    await expect(lbl).toHaveText('2-3')
  })

  test('a user-inserted blank page re-aligns the following pairs and persists', async ({ page }) => {
    await page.goto('/')
    await importBooks(page, ['manga-vol-01.cbz'])
    await openBook(page, 'manga-vol-01')
    const lbl = label(page)
    await page.keyboard.press('ArrowLeft')
    await expect(lbl).toHaveText('2-3')
    // The spread 2-3 is wrong: 3-4 belong together. Insert a blank before page 2.
    await page.mouse.move(CENTER.x, CENTER.y)
    await page.getByTestId('toggle-blank').click()
    await expect(lbl).toHaveText('2')
    await expect(page.getByTestId('blank-page')).toBeVisible()
    // RTL: the blank is read first, so it sits on the right and page 2 on the left.
    const b2 = await pageBox(page, 2)
    const blank = (await page.getByTestId('blank-page').boundingBox())!
    expect(blank.x).toBeGreaterThan(b2.x)
    await page.keyboard.press('ArrowLeft')
    await expect(lbl).toHaveText('3-4')
    await page.keyboard.press('ArrowLeft')
    await expect(lbl).toHaveText('5-6')
    await page.waitForTimeout(400)
    await page.reload()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
    await expect(lbl).toHaveText('5-6')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowLeft')
    await expect(lbl).toHaveText('2')
    await page.mouse.move(CENTER.x, CENTER.y)
    await page.getByTestId('toggle-blank').click()
    await expect(lbl).toHaveText('2-3')
    await expect(page.getByTestId('blank-page')).toHaveCount(0)
  })

  test('touch taps and swipes navigate', async ({ page }) => {
    await page.goto('/')
    await importBooks(page, ['short-book.cbz'])
    await openBook(page, 'short-book')
    await page.touchscreen.tap(LEFT.x, LEFT.y)
    await expect(label(page)).toHaveText('2-3')
    await page.touchscreen.tap(RIGHT.x, RIGHT.y)
    await expect(label(page)).toHaveText('1')
    // Swipe right (finger moves right) reveals the next page in RTL.
    await page.mouse.move(300, 400)
    await page.mouse.down()
    await page.mouse.move(500, 405, { steps: 8 })
    await page.mouse.move(700, 410, { steps: 8 })
    await page.mouse.up()
    await expect(label(page)).toHaveText('2-3')
  })

  test('zoom: double tap, ctrl+wheel, bake into layout, reset on page turn', async ({ page }) => {
    await page.goto('/')
    await importBooks(page, ['short-book.cbz'])
    await openBook(page, 'short-book')
    const canvas = page.getByTestId('canvas')
    await expect(canvas).toHaveAttribute('data-zoom', '1.000')
    const base = (await canvas.boundingBox())!

    await page.mouse.dblclick(CENTER.x, CENTER.y)
    await expect(canvas).toHaveAttribute('data-zoom', '2.500')
    const zoomed = (await canvas.boundingBox())!
    expect(zoomed.width / base.width).toBeCloseTo(2.5, 1)
    // The layout grew (bake): the image element itself is 2.5x larger, not just transformed.
    const img = page.locator('[data-testid=page][data-page="1"] img')
    expect((await img.boundingBox())!.width / base.width).toBeCloseTo(2.5, 1)
    await expect(canvas).toHaveCSS('transform', /matrix\(1, 0, 0, 1, /)

    await page.mouse.dblclick(CENTER.x, CENTER.y)
    await expect(canvas).toHaveAttribute('data-zoom', '1.000')

    await page.keyboard.down('Control')
    await page.mouse.move(CENTER.x, CENTER.y)
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(50)
    const z1 = Number(await canvas.getAttribute('data-zoom'))
    expect(z1).toBeGreaterThan(1.2)
    // A burst of wheel events must accumulate (no stale zoom between frames).
    await page.mouse.wheel(0, -300)
    await page.mouse.wheel(0, -300)
    await page.keyboard.up('Control')
    await page.waitForTimeout(50)
    const z2 = Number(await canvas.getAttribute('data-zoom'))
    expect(z2).toBeGreaterThan(z1 * 1.3)

    // Turning the page resets the zoom.
    await page.keyboard.press('ArrowLeft')
    await expect(label(page)).toHaveText('2-3')
    await expect(canvas).toHaveAttribute('data-zoom', '1.000')
  })

  test('reading position and pairing persist across reloads and show in the library', async ({ page }) => {
    await page.goto('/')
    await importBooks(page, ['manga-vol-01.cbz'])
    await openBook(page, 'manga-vol-01')
    for (const expected of ['2-3', '4-5', '6-7', '8-9']) {
      await page.keyboard.press('ArrowLeft')
      await expect(label(page)).toHaveText(expected)
    }
    await page.waitForTimeout(500) // debounce of the progress writer
    await page.reload()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
    await expect(label(page)).toHaveText('8-9')
    // Page sizes were persisted: jumping straight to the wide page keeps it alone.
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(label(page)).toHaveText('12')
    await page.getByTestId('back').click()
    await expect(page.getByTestId('book-progress')).toHaveText('Pagina 12 di 19')
  })

  test('CBR: lists and extracts pages through the unrar worker, wide page alone', async ({ page }) => {
    await page.goto('/')
    const statuses = await importBooks(page, ['stored-book.cbr'])
    expect(statuses).toEqual(['Importato'])
    await expect(page.locator('[data-testid=book-card]')).toContainText('cbr')
    await expect(page.locator('[data-testid=book-card] img')).toHaveCount(1)
    await openBook(page, 'stored-book')
    await expect(label(page)).toHaveText('1')
    await expect(page.locator('[data-testid=page][data-page="1"] img')).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(label(page)).toHaveText('2')
    // page 3 is landscape: shown alone, so the pair 2-3 is broken up
    await page.keyboard.press('ArrowLeft')
    await expect(label(page)).toHaveText('3')
    const b3 = await pageBox(page, 3)
    expect(b3.width).toBeGreaterThan(b3.height)
    await page.keyboard.press('ArrowLeft')
    await expect(label(page)).toHaveText('4-5')
    await expect(page.locator('[data-testid=page] img')).toHaveCount(2)
  })

  test('CBR error paths: no images, encrypted headers', async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('[data-testid=session-input]', fx('FolderTest.cbr'))
    await expect(page.getByTestId('error-message')).toContainText('non contiene immagini')
    await page.getByRole('button', { name: 'OK' }).click()
    await page.setInputFiles('[data-testid=session-input]', fx('HeaderEnc1234.cbr'))
    await expect(page.getByTestId('error-message')).toContainText('protetto da password')
  })

  test('reader background: default follows the appearance, black and white are fixed and persist', async ({ page }) => {
    await page.goto('/')
    await importBooks(page, ['short-book.cbz'])
    await openBook(page, 'short-book')
    const stage = page.getByTestId('stage')
    await expect(stage).toHaveAttribute('data-background', 'default')
    await expect(stage).toHaveCSS('background-color', 'rgb(233, 233, 238)') // light appearance stage token
    await page.mouse.move(CENTER.x, CENTER.y)
    await page.getByTestId('settings').click()
    await page.getByTestId('bg-black').click()
    await expect(stage).toHaveCSS('background-color', 'rgb(0, 0, 0)')
    await page.getByTestId('bg-white').click()
    await expect(stage).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    // Forcing the dark appearance does not override an explicit background.
    await page.getByTestId('theme-dark').click()
    await expect(stage).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await page.getByTestId('bg-default').click()
    await expect(stage).toHaveCSS('background-color', 'rgb(0, 0, 0)') // dark appearance stage token
    await page.getByTestId('bg-black').click()
    await page.getByTestId('theme-system').click()
    await page.reload()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready', { timeout: 20_000 })
    await expect(page.getByTestId('stage')).toHaveCSS('background-color', 'rgb(0, 0, 0)')
  })

  test('page-turn transitions: slide (default) and fade animate a ghost of the leaving spread, none does not', async ({ page }) => {
    await page.goto('/')
    await importBooks(page, ['manga-vol-01.cbz'])
    await openBook(page, 'manga-vol-01')
    await expect(page.locator('[data-testid=page][data-page="1"] img')).toBeVisible()
    const ghost = page.getByTestId('spread-ghost')
    // Slide (default): RTL forward turn -> the old spread leaves to the right.
    await page.keyboard.press('ArrowLeft')
    await expect(ghost).toHaveClass(/spread-out-right/)
    await expect(ghost).toHaveCount(0, { timeout: 2000 })
    await expect(label(page)).toHaveText('2-3')
    // Backwards: leaves to the left.
    await page.keyboard.press('ArrowRight')
    await expect(ghost).toHaveClass(/spread-out-left/)
    await expect(ghost).toHaveCount(0, { timeout: 2000 })

    await page.mouse.move(CENTER.x, CENTER.y)
    await page.getByTestId('settings').click()
    await page.getByTestId('tr-fade').click()
    await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()
    await page.keyboard.press('ArrowLeft')
    await expect(ghost).toHaveClass(/spread-out-fade/)
    await expect(ghost).toHaveCount(0, { timeout: 2000 })

    await page.mouse.move(CENTER.x, CENTER.y)
    await page.getByTestId('settings').click()
    await page.getByTestId('tr-none').click()
    await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()
    await page.keyboard.press('ArrowLeft')
    await expect(label(page)).toHaveText('4-5')
    await expect(ghost).toHaveCount(0)
  })

  test('full screen while reading (hides the status bar), off when leaving or disabled', async ({ page }) => {
    await page.goto('/')
    const supported = await page.evaluate(() => document.fullscreenEnabled)
    test.skip(!supported, 'Fullscreen API not available in this browser')
    await importBooks(page, ['short-book.cbz'])
    await openBook(page, 'short-book')
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true)
    await page.getByTestId('back').click()
    await expect(page.getByTestId('book-card')).toHaveCount(1)
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false)
    // Disabled in the settings: opening a book stays in the normal window.
    await openBook(page, 'short-book')
    await page.mouse.move(CENTER.x, CENTER.y)
    await page.getByTestId('settings').click()
    await page.getByRole('switch', { name: 'Schermo intero durante la lettura' }).click()
    await page.getByRole('button', { name: 'Chiudi impostazioni' }).click()
    await page.getByTestId('back').click()
    await expect(page.getByTestId('book-card')).toHaveCount(1)
    await openBook(page, 'short-book')
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(false)
  })

  test('a missing book shows a clear error', async ({ page }) => {
    await page.goto('/#/read/does-not-exist')
    await expect(page.getByTestId('reader-error')).toContainText('non è più presente')
    await page.getByRole('button', { name: 'Torna alla libreria' }).click()
    await expect(page.getByTestId('empty-library')).toBeVisible()
  })
})

test.describe('pwa (preview build only)', () => {
  test.skip(!PREVIEW, 'needs the production build served by vite preview')

  test('service worker serves the app shell offline', async ({ page, context }) => {
    await page.goto('/')
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.ready))
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 }).catch(async () => {
      await page.reload()
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 20_000 })
    })
    await importBooks(page, ['short-book.cbz'])
    await context.setOffline(true)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Libreria' })).toBeVisible()
    await expect(page.getByTestId('book-card')).toHaveCount(1)
    await openBook(page, 'short-book')
    await expect(label(page)).toHaveText('1')
    await context.setOffline(false)
  })
})
