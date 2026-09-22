import { expect, type Page, test } from '@playwright/test'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  const declineOnline = page.getByRole('button', { name: 'Non ora' })
  if (await declineOnline.isVisible()) await declineOnline.click()
  for (let i = 0; i < names.length; i++) {
    const keep = page.getByRole('button', { name: 'Mantieni attuale' })
    if (!(await keep.isVisible())) break
    await keep.click()
    await page.waitForTimeout(0)
  }
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
    const onlineTitleRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().startsWith('https://openlibrary.org/') || request.url().startsWith('https://graphql.anilist.co/')) onlineTitleRequests.push(request.url())
    })
    await page.goto('/')
    await page.evaluate(() => localStorage.setItem('reader.cover-search-consent-v4', 'yes'))
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
    expect(onlineTitleRequests).toHaveLength(0)
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
                hasCover: 'coverData' in book || 'cover' in book,
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
    await page.getByRole('button', { name: 'Modifica short-book' }).click()
    await page.getByRole('button', { name: 'Elimina' }).click()
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

  test('reports a blocked v1→v2 library migration instead of loading forever', async ({ page, context }) => {
    await page.goto('/icons/icon.svg')
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const remove = indexedDB.deleteDatabase('cbz-reader')
          remove.onerror = () => reject(remove.error)
          remove.onsuccess = () => {
            const open = indexedDB.open('cbz-reader', 1)
            open.onerror = () => reject(open.error)
            open.onupgradeneeded = () => {
              const books = open.result.createObjectStore('books', { keyPath: 'id' })
              books.createIndex('byAdded', 'addedAt')
              open.result.createObjectStore('progress', { keyPath: 'bookId' })
              open.result.createObjectStore('pageSizes', { keyPath: 'bookId' })
              open.result.createObjectStore('files', { keyPath: 'bookId' })
            }
            open.onsuccess = () => {
              ;(window as unknown as { __oldReaderDb: IDBDatabase }).__oldReaderDb = open.result
              resolve()
            }
          }
        }),
    )
    const other = await context.newPage()
    await other.goto('/')
    await expect(other.getByTestId('error-message')).toContainText('altra scheda', { timeout: 12_000 })
    await page.evaluate(() => (window as unknown as { __oldReaderDb: IDBDatabase }).__oldReaderDb.close())
    await other.reload()
    await expect(other.getByTestId('empty-library')).toBeVisible()
    await other.close()
  })

  test('creates activity-sorted collections, moves and renames books, and deletes a collection', async ({ page }) => {
    const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#f28c1e" d="M4 4h16v16H4z"/></svg>'
    await page.route('https://api.iconify.design/search**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          icons: ['lucide:skull'],
          collections: { lucide: { license: { title: 'ISC' } } },
        }),
      }),
    )
    await page.route('https://api.iconify.design/lucide/skull.svg**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: iconSvg }),
    )
    await page.goto('/')
    await importBooks(page, ['manga-vol-01.cbz', 'short-book.cbz'])

    const createCollection = async (name: string) => {
      await page.getByTestId('new-collection').click()
      await page.getByLabel('Nome collezione').fill(name)
      await page.getByRole('button', { name: 'Crea' }).click()
      await expect(page.getByRole('heading', { name })).toBeVisible()
    }
    await createCollection('One Piece')
    await createCollection('Berserk')

    const tabs = page.getByTestId('collection-tabs')
    const onePieceNav = tabs.getByRole('button', { name: /One Piece/ }).first()
    await expect(onePieceNav.locator('img, svg')).toHaveCount(0)
    await expect(page.getByTestId('collection-all').locator('svg')).toBeVisible()
    await page.getByRole('button', { name: 'Azioni collezione One Piece' }).click()
    await page.getByRole('button', { name: 'Modifica collezione' }).click()
    const collectionDialog = page.getByRole('dialog', { name: 'Modifica collezione' })
    await expect(collectionDialog.getByRole('button', { name: 'Nessuna icona' })).toHaveAttribute('aria-pressed', 'true')
    await collectionDialog.getByLabel('Cerca icone online').fill('pirate')
    await collectionDialog.getByRole('button', { name: 'Cerca' }).click()
    await collectionDialog.getByRole('button', { name: 'Scegli icona skull' }).click()
    await expect(collectionDialog.locator('img')).toBeVisible()
    await collectionDialog.getByRole('button', { name: 'Salva' }).click()
    await expect(tabs.getByRole('button', { name: /One Piece/ }).first().locator('img')).toBeVisible()

    await page.getByTestId('collection-default').click()
    await page.getByRole('button', { name: 'Modifica manga-vol-01' }).click()
    await page.getByTestId('book-title-input').fill('One Piece Vol. 46')
    await page.getByTestId('book-collection-select').selectOption({ label: 'One Piece' })
    await page.getByRole('button', { name: 'Salva' }).click()
    await expect(page.getByRole('button', { name: 'Apri manga-vol-01' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Modifica short-book' }).click()
    await page.getByTestId('book-title-input').fill('Berserk Deluxe 1')
    await page.getByTestId('book-collection-select').selectOption({ label: 'Berserk' })
    await page.getByRole('button', { name: 'Salva' }).click()

    const onePiece = tabs.getByRole('button', { name: /One Piece/ }).first()
    const berserk = tabs.getByRole('button', { name: /Berserk/ }).first()
    await onePiece.click()
    await expect(page.getByRole('button', { name: 'Apri One Piece Vol. 46' })).toBeVisible()
    await page.getByRole('button', { name: 'Apri One Piece Vol. 46' }).click()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready')
    await page.getByTestId('back').click()

    // Returning from the most recently read book selects its collection and sorts it first (tabs run left to right).
    await expect(page.getByRole('heading', { name: 'One Piece' })).toBeVisible()
    const oneBox = (await onePiece.boundingBox())!
    const berserkBox = (await berserk.boundingBox())!
    expect(oneBox.x).toBeLessThan(berserkBox.x)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'One Piece' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Apri One Piece Vol. 46' })).toBeVisible()

    await berserk.click()
    await page.getByRole('button', { name: 'Azioni collezione Berserk' }).click()
    await page.getByRole('button', { name: 'Elimina collezione' }).click()
    await page.getByTestId('confirm-delete-collection').click()
    await expect(page.getByRole('heading', { name: 'Senza collezione' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Apri Berserk Deluxe 1' })).toBeVisible()
  })

  test('rejects active SVG content returned by online icon search', async ({ page }) => {
    await page.route('https://api.iconify.design/search**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ icons: ['lucide:bad-icon'], collections: {} }),
      }),
    )
    await page.route('https://api.iconify.design/lucide/bad-icon.svg**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        headers: { 'access-control-allow-origin': '*' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="urn:bad"><s:script>alert(1)</s:script><path d="M0 0h1v1z"/></svg>',
      }),
    )
    await page.goto('/')
    await page.getByTestId('new-collection').click()
    const dialog = page.getByRole('dialog', { name: 'Nuova collezione' })
    await dialog.getByLabel('Nome collezione').fill('Unsafe')
    await dialog.getByLabel('Cerca icone online').fill('bad')
    await dialog.getByRole('button', { name: 'Cerca' }).click()
    await dialog.getByRole('button', { name: 'Scegli icona bad icon' }).click()
    await expect(dialog.getByText(/elementi non ammessi/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Nessuna icona' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('suggests online covers after import and stores the selected image locally', async ({ page }) => {
    const coverPng = readFileSync(fx('cover.png'))
    await page.route('https://openlibrary.org/search.json**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ docs: [{ key: '/works/OL1W', title: 'Short Book', author_name: ['Test Author'], cover_i: 123 }] }),
      }),
    )
    await page.route('https://graphql.anilist.co/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"data":{"Page":{"media":[]}}}' }),
    )
    await page.route('https://images.weserv.nl/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: coverPng }),
    )
    await page.goto('/')
    await page.setInputFiles('[data-testid=import-input]', fx('short-book.cbz'))
    const overlay = page.getByTestId('import-overlay')
    await expect(overlay.getByText('Importazione completata')).toBeVisible({ timeout: 30_000 })
    const originalSize = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const open = indexedDB.open('cbz-reader')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const get = open.result.transaction('books').objectStore('books').getAll()
            get.onerror = () => reject(get.error)
            get.onsuccess = () => resolve((get.result[0].coverData as { bytes: ArrayBuffer }).bytes.byteLength)
          }
        }),
    )
    await overlay.getByTestId('import-close').click()
    await expect(page.getByText(/invierà i titoli.*Open Library/)).toBeVisible()
    await page.getByTestId('accept-cover-search').click()
    const coverDialog = page.getByTestId('cover-search-dialog')
    await expect(coverDialog).toBeVisible()
    await expect(coverDialog.getByText('Short Book')).toBeVisible()
    await coverDialog.getByTestId('cover-candidate').click()
    await expect(coverDialog).toHaveCount(0)
    const selectedSize = await page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const open = indexedDB.open('cbz-reader')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const get = open.result.transaction('books').objectStore('books').getAll()
            get.onerror = () => reject(get.error)
            get.onsuccess = () => resolve((get.result[0].coverData as { bytes: ArrayBuffer }).bytes.byteLength)
          }
        }),
    )
    expect(selectedSize).not.toBe(originalSize)
    await expect(page.locator('[data-testid=book-card] img')).toBeVisible()
  })

  test('falls back to AniList when Open Library has no volume', async ({ page }) => {
    const coverPng = readFileSync(fx('cover.png'))
    await page.route('https://openlibrary.org/search.json**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"docs":[]}' }),
    )
    await page.route('https://graphql.anilist.co/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          data: {
            Page: {
              media: [
                {
                  id: 30013,
                  title: { english: 'AniList-only Series' },
                  coverImage: {
                    extraLarge: 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/test.jpg',
                    large: 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/test.jpg',
                  },
                },
              ],
            },
          },
        }),
      }),
    )
    await page.route('https://s4.anilist.co/file/anilistcdn/media/manga/cover/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: coverPng }),
    )
    await page.goto('/')
    await page.setInputFiles('[data-testid=import-input]', fx('short-book.cbz'))
    const overlay = page.getByTestId('import-overlay')
    await expect(overlay.getByText('Importazione completata')).toBeVisible()
    await overlay.getByTestId('import-close').click()
    await page.getByTestId('accept-cover-search').click()
    const dialog = page.getByTestId('cover-search-dialog')
    await expect(dialog.getByText(/AniList-only Series/)).toBeVisible()
    await expect(dialog.getByText(/AniList/).last()).toBeVisible()
    await dialog.getByTestId('cover-candidate').click()
    await expect(dialog).toHaveCount(0)
  })

  test('canceling a cover during download cannot overwrite the current cover', async ({ page }) => {
    const coverPng = readFileSync(fx('cover.png'))
    await page.route('https://openlibrary.org/search.json**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ docs: [{ key: '/works/OL2W', title: 'Short Book', cover_i: 456 }] }),
      }),
    )
    await page.route('https://graphql.anilist.co/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"data":{"Page":{"media":[]}}}' }),
    )
    await page.route('https://images.weserv.nl/**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('w') === '960') await new Promise((resolve) => setTimeout(resolve, 500))
      await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: coverPng }).catch(() => undefined)
    })
    const coverSize = () =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const open = indexedDB.open('cbz-reader')
            open.onerror = () => reject(open.error)
            open.onsuccess = () => {
              const get = open.result.transaction('books').objectStore('books').getAll()
              get.onerror = () => reject(get.error)
              get.onsuccess = () => resolve((get.result[0].coverData as { bytes: ArrayBuffer }).bytes.byteLength)
            }
          }),
      )
    await page.goto('/')
    await page.setInputFiles('[data-testid=import-input]', fx('short-book.cbz'))
    const overlay = page.getByTestId('import-overlay')
    await expect(overlay.getByText('Importazione completata')).toBeVisible()
    const before = await coverSize()
    await overlay.getByTestId('import-close').click()
    await page.getByTestId('accept-cover-search').click()
    const dialog = page.getByTestId('cover-search-dialog')
    await expect(dialog.getByTestId('cover-candidate')).toBeVisible()
    await dialog.getByTestId('cover-candidate').click()
    await dialog.getByRole('button', { name: 'Mantieni attuale' }).click()
    await expect(dialog).toHaveCount(0)
    await page.waitForTimeout(700)
    expect(await coverSize()).toBe(before)
  })

  test('a manually selected remote cover survives for a password-protected book', async ({ page }) => {
    const coverPng = readFileSync(fx('cover.png'))
    await page.route('https://openlibrary.org/search.json**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ docs: [{ key: '/works/OL3W', title: 'Protected Book', cover_i: 789 }] }),
      }),
    )
    await page.route('https://graphql.anilist.co/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"data":{"Page":{"media":[]}}}' }),
    )
    await page.route('https://images.weserv.nl/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: coverPng }),
    )
    await page.goto('/')
    await page.setInputFiles('[data-testid=import-input]', fx('protected.zip'))
    await page.getByLabel('Password dell’archivio').fill('segreto')
    await page.getByRole('button', { name: 'Sblocca' }).click()
    const overlay = page.getByTestId('import-overlay')
    await expect(overlay.getByText('Importazione completata')).toBeVisible()
    await overlay.getByTestId('import-close').click()
    await expect(page.locator('[data-testid=book-card] img')).toHaveCount(0)

    await page.getByRole('button', { name: 'Modifica protected' }).click()
    await page.getByRole('button', { name: 'Cerca copertina online' }).click()
    const dialog = page.getByTestId('cover-search-dialog')
    await expect(dialog.getByTestId('cover-candidate')).toBeVisible()
    await dialog.getByTestId('cover-candidate').click()
    await expect(dialog).toHaveCount(0)
    await page.reload()
    await expect(page.locator('[data-testid=book-card] img')).toBeVisible()

    await page.getByRole('button', { name: 'Apri protected' }).click()
    await page.getByLabel('Password dell’archivio').fill('segreto')
    await page.getByRole('button', { name: 'Sblocca' }).click()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-status', 'ready')
    await page.getByTestId('back').click()
    await expect(page.locator('[data-testid=book-card] img')).toBeVisible()
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

  test('filters the grid by reading state and sorts it; the choice persists', async ({ page }) => {
    await page.goto('/')
    await importBooks(page, ['manga-vol-01.cbz', 'short-book.cbz', 'zip64-book.cbz'])
    const titles = () => page.locator('[data-testid=book-card] .line-clamp-2').allTextContents()
    // One pill by the section title opens "Ordina e filtra"; choices apply at once, "Fine" closes it.
    const openView = () => page.getByTestId('library-view').click()
    const closeView = () => page.getByTestId('library-view-done').click()
    await expect(page.getByTestId('library-view')).toHaveText('Recenti')

    await openView()
    await page.getByTestId('filter-finished').click()
    await closeView()
    await expect(page.getByTestId('library-view')).toHaveText('Finiti · Recenti')
    await expect(page.getByTestId('library-view')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('grid-empty')).toContainText('Nessun volume finito in questa collezione.')
    await page.getByRole('button', { name: 'Mostra tutti' }).click()
    await expect(page.getByTestId('book-card')).toHaveCount(3)
    await expect(page.getByTestId('library-view')).toHaveAttribute('aria-pressed', 'false')

    await openBook(page, 'manga-vol-01')
    await page.keyboard.press('ArrowLeft')
    await expect(label(page)).toHaveText('2-3')
    await page.waitForTimeout(500)
    await page.getByTestId('back').click()
    await openBook(page, 'short-book')
    await page.keyboard.press('End')
    await expect(label(page)).toHaveText('6')
    await page.waitForTimeout(500)
    await page.getByTestId('back').click()

    await openView()
    await page.getByTestId('filter-reading').click()
    expect(await titles()).toEqual(['manga-vol-01'])
    await expect(page.getByTestId('grid-count')).toHaveText('1 di 3 volumi · 1 in lettura')
    await page.getByTestId('filter-finished').click()
    expect(await titles()).toEqual(['short-book'])
    await page.getByTestId('filter-unread').click()
    expect(await titles()).toEqual(['zip64-book'])

    await page.getByTestId('filter-all').click()
    await page.getByTestId('sort-title').click()
    expect(await titles()).toEqual(['manga-vol-01', 'short-book', 'zip64-book'])
    await page.getByTestId('sort-recent').click()
    expect(await titles()).toEqual(['short-book', 'manga-vol-01', 'zip64-book'])
    await page.getByTestId('sort-added').click()
    await page.getByTestId('filter-reading').click()
    await closeView()
    await expect(page.getByTestId('library-view')).toHaveText('In lettura · Aggiunti')
    await page.reload()
    await expect(page.getByTestId('library-view')).toHaveText('In lettura · Aggiunti')
    expect(await titles()).toEqual(['manga-vol-01'])
    await openView()
    await expect(page.getByTestId('sort-added')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('filter-reading')).toHaveAttribute('aria-pressed', 'true')
  })

  test('backs up the library and restores it on a fresh install, re-attaching the data when the files come back', async ({ page, browser }) => {
    await page.goto('/')
    await importBooks(page, ['manga-vol-01.cbz', 'short-book.cbz'])
    await page.getByTestId('new-collection').click()
    await page.getByLabel('Nome collezione').fill('Seinen')
    await page.getByRole('button', { name: 'Crea' }).click()
    await page.getByTestId('collection-default').click()
    await page.getByRole('button', { name: 'Modifica manga-vol-01' }).click()
    await page.getByTestId('book-title-input').fill('Vinland Saga 1')
    await page.getByTestId('book-collection-select').selectOption({ label: 'Seinen' })
    await page.getByRole('button', { name: 'Salva' }).click()
    await page.getByTestId('collection-all').click()
    await openBook(page, 'Vinland Saga 1')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(label(page)).toHaveText('4-5')
    await page.waitForTimeout(500)
    await page.getByTestId('back').click()
    await expect(page.getByTestId('book-progress').first()).toHaveText(/^Pagina 4 di 19/)
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('reader.settings.v1') ?? '{}')
      localStorage.setItem('reader.settings.v1', JSON.stringify({ ...settings, direction: 'ltr', theme: 'dark' }))
    })

    // Export: no share sheet in this browser, so the backup is downloaded.
    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('library-menu').click()
    await page.getByTestId('export-backup').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^Mangadana-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const backupPath = join(tmpdir(), `mangadana-e2e-${Date.now()}.json`)
    await download.saveAs(backupPath)
    const backup = JSON.parse(readFileSync(backupPath, 'utf8'))
    expect(backup.format).toBe('mangadana-backup')
    expect(backup.collections.map((c: { name: string }) => c.name)).toEqual(['Seinen'])
    expect(backup.books.map((b: { title: string; fileName: string; progress?: { page: number } }) => [b.title, b.fileName, b.progress?.page])).toEqual([
      ['Vinland Saga 1', 'manga-vol-01.cbz', 3],
      ['short-book', 'short-book.cbz', undefined],
    ])
    expect(backup.books[0].collectionId).toBe(backup.collections[0].id)
    expect(backup.settings).toMatchObject({ direction: 'ltr', theme: 'dark' })

    // A fresh install (another browser profile): restore, then import one of the two files.
    const fresh = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true, baseURL: new URL(page.url()).origin })
    const other = await fresh.newPage()
    await other.goto('/')
    await expect(other.getByTestId('empty-library')).toBeVisible()
    const chooserPromise = other.waitForEvent('filechooser')
    await other.getByTestId('restore-empty').click()
    await (await chooserPromise).setFiles(backupPath)
    const summary = other.getByTestId('restore-summary')
    await expect(summary).toContainText('2 volumi da importare di nuovo')
    await expect(summary).toContainText('1 collezione creata.')
    await expect(summary).toContainText('Impostazioni di lettura ripristinate.')
    await other.getByRole('button', { name: 'Più tardi' }).click()
    expect(JSON.parse(await other.evaluate(() => localStorage.getItem('reader.settings.v1') ?? '{}'))).toMatchObject({ direction: 'ltr', theme: 'dark' })
    await expect(other.getByTestId('pending-restores')).toContainText('2 volumi da importare di nuovo.')
    await expect(other.getByTestId('empty-library')).toBeVisible()

    await importBooks(other, ['manga-vol-01.cbz'])
    await other.getByTestId('collection-all').click()
    await expect(other.getByRole('button', { name: 'Apri Vinland Saga 1' })).toBeVisible()
    await expect(other.getByTestId('book-progress')).toHaveText(/^Pagina 4 di 19/)
    await expect(other.getByTestId('collection-tabs').getByRole('button', { name: /Seinen/ }).first()).toContainText('1')
    await expect(other.getByTestId('pending-restores')).toContainText('1 volume da importare di nuovo.')
    await other.getByTestId('pending-restores-list').click()
    await expect(other.getByTestId('pending-list')).toContainText('short-book')
    await other.getByTestId('dismiss-pending').click()
    await expect(other.getByTestId('pending-restores')).toHaveCount(0)

    // Restoring the same backup here again changes nothing: the edited volume keeps its data, nothing is pending.
    await other.setInputFiles('[data-testid=restore-input]', backupPath)
    await expect(other.getByTestId('restore-summary')).toContainText('1 volume già in libreria aggiornato.')
    await expect(other.getByTestId('restore-summary')).toContainText('1 volume da importare di nuovo')
    await other.getByRole('button', { name: 'Più tardi' }).click()
    await expect(other.getByRole('button', { name: 'Apri Vinland Saga 1' })).toBeVisible()
    await fresh.close()
    rmSync(backupPath, { force: true })
  })

  test('web catalogue: add a site, browse its series, download a chapter range into a CBZ in the series collection', async ({ page }) => {
    const pagePng = readFileSync(fx('cover.png'))
    const cors = { 'access-control-allow-origin': '*' }
    const card = (slug: string, title: string, author: string, blurb: string) =>
      `<a href="/${slug}"><img src="/covers/${slug}.jpg" alt=""/><h3>${title}</h3><span>${author}</span><span>·</span><span>${blurb}</span><span>Read →</span></a>`
    const chapterRow = (n: number, name: string, pages: number, extra = '') =>
      `<li><a href="/demo-series/chapter/${n}"><span>Chapter</span><span>${n}</span>${extra}<span>${name}</span><span>${pages}</span><span>pages ·</span><span>Arc</span><span>Read →</span></a></li>`
    await page.route('https://catalog.test/**', (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/') {
        return route.fulfill({ status: 200, contentType: 'text/html', headers: cors, body: `<html><body><header><a href="/"><img src="/logo-mark.png" width="32" height="32"/></a></header><main>${card('demo-series', 'Demo Series', 'Ada Autrice', '3 colored chapters')}${card('other-series', 'Other Series', 'Bo Autore', '12 chapters in full color')}</main></body></html>` })
      }
      if (url.pathname === '/demo-series') {
        return route.fulfill({ status: 200, contentType: 'text/html', headers: cors, body: `<html><body><main><a href="/demo-series/chapter/1">Start · Chapter 1 →</a><ul>${chapterRow(1, 'Primo', 3)}${chapterRow(2, 'Secondo', 3, '<span>Partial color</span>')}${chapterRow(3, 'Terzo', 3)}</ul></main></body></html>` })
      }
      const chapter = /^\/demo-series\/chapter\/(\d+)$/.exec(url.pathname)
      if (chapter) {
        const imgs = [1, 2, 3].map((i) => `<img src="https://pages.test/ch${chapter[1]}/${i}.png" alt="page ${i}" width="800" height="1200"/>`).join('')
        return route.fulfill({ status: 200, contentType: 'text/html', headers: cors, body: `<html><body><header><img src="/logo-mark.png" width="32" height="32"/></header><main>${imgs}</main></body></html>` })
      }
      if (url.pathname.startsWith('/covers/')) return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: pagePng })
      return route.fulfill({ status: 404, headers: cors, body: 'no' })
    })
    await page.route('https://pages.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: pagePng }))

    await page.goto('/')
    await page.getByTestId('catalogs').click()
    const dialog = page.getByTestId('catalog-dialog')
    await dialog.getByTestId('catalog-url').fill('catalog.test')
    await dialog.getByTestId('catalog-add').click()
    await expect(dialog.getByTestId('catalog-list')).toContainText('catalog.test')
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('reader.catalogs.v1') ?? '[]'))).toMatchObject([{ url: 'https://catalog.test', name: 'catalog.test' }])

    await dialog.getByTestId('catalog-open').click()
    await expect(dialog.getByTestId('catalog-series-card')).toHaveCount(2)
    await dialog.getByTestId('catalog-series-card').filter({ hasText: 'Demo Series' }).click()
    const rows = dialog.getByTestId('catalog-units').locator('li')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(1)).toContainText('Colore parziale')
    await expect(rows.nth(0)).toContainText('3 pagine')
    // The range defaults to everything the limit allows; narrow it to chapters 1-2.
    await dialog.getByTestId('catalog-to').selectOption('2')
    await expect(dialog.getByTestId('catalog-download')).toHaveText('Scarica 2 capitoli')
    await dialog.getByTestId('catalog-download').click()

    // The CBZ goes through the normal import, into a collection named after the series.
    const overlay = page.getByTestId('import-overlay')
    await expect(overlay.getByText('Importazione completata')).toBeVisible({ timeout: 30_000 })
    await expect(overlay).toContainText('Demo Series — Cap. 001-002.cbz')
    await overlay.getByTestId('import-close').click()
    const declineOnline = page.getByRole('button', { name: 'Non ora' })
    if (await declineOnline.isVisible()) await declineOnline.click()
    await expect(page.getByRole('heading', { name: 'Demo Series' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Apri Demo Series — Cap. 001-002' })).toBeVisible()
    await expect(page.getByTestId('book-progress')).toContainText('6 pagine')
    await expect(page.getByTestId('collection-tabs').getByRole('button', { name: /Demo Series/ }).first()).toContainText('1')

    // Pages read in order: chapter 1 first, then chapter 2 (folders "Cap. 001", "Cap. 002").
    await openBook(page, 'Demo Series — Cap. 001-002')
    await expect(label(page)).toHaveText('1')
    await page.keyboard.press('End')
    await expect(label(page)).toHaveText('6')
  })

  test('covers live as bytes in the record: legacy Blob covers are converted, a missing cover is rebuilt from the first page', async ({ page }) => {
    await page.goto('/')
    await importBooks(page, ['short-book.cbz', 'manga-vol-01.cbz'])
    await expect(page.locator('[data-testid=book-card] img')).toHaveCount(2)
    // Rewrite the records the way earlier versions stored them: one with a Blob cover, one with none.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('cbz-reader')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const tx = open.result.transaction('books', 'readwrite')
            const store = tx.objectStore('books')
            const all = store.getAll()
            all.onsuccess = () => {
              for (const record of all.result as Array<Record<string, unknown>>) {
                const data = record.coverData as { bytes: ArrayBuffer; type: string } | undefined
                if (record.fileName === 'short-book.cbz' && data) record.cover = new Blob([data.bytes], { type: data.type })
                delete record.coverData
                if (record.fileName === 'manga-vol-01.cbz') delete record.coverSource
                store.put(record)
              }
            }
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
          }
        }),
    )
    await page.reload()
    // Both covers are back: the legacy Blob converted, the missing one rebuilt from page 1.
    await expect(page.locator('[data-testid=book-card] img')).toHaveCount(2, { timeout: 20_000 })
    const stored = await page.evaluate(
      () =>
        new Promise<Array<{ fileName: string; hasBlob: boolean; bytes: number; type: string; source: string }>>((resolve, reject) => {
          const open = indexedDB.open('cbz-reader')
          open.onerror = () => reject(open.error)
          open.onsuccess = () => {
            const get = open.result.transaction('books').objectStore('books').getAll()
            get.onerror = () => reject(get.error)
            get.onsuccess = () =>
              resolve(
                (get.result as Array<Record<string, unknown>>)
                  .map((record) => ({
                    fileName: record.fileName as string,
                    hasBlob: 'cover' in record,
                    bytes: (record.coverData as { bytes: ArrayBuffer } | undefined)?.bytes.byteLength ?? 0,
                    type: (record.coverData as { type: string } | undefined)?.type ?? '',
                    source: record.coverSource as string,
                  }))
                  .sort((a, b) => a.fileName.localeCompare(b.fileName)),
              )
          }
        }),
    )
    expect(stored.map((s) => [s.fileName, s.hasBlob, s.bytes > 1000, s.type, s.source])).toEqual([
      ['manga-vol-01.cbz', false, true, 'image/jpeg', 'archive'],
      ['short-book.cbz', false, true, 'image/jpeg', 'archive'],
    ])
  })

  test('a file that is not a backup is refused with a clear message', async ({ page }) => {
    await page.goto('/')
    await page.setInputFiles('[data-testid=restore-input]', { name: 'note.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') })
    await expect(page.getByTestId('error-message')).toHaveText('Il file non è un backup di Mangadana.')
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

    // The pairing is fixed (cover alone, then 2-3, 4-5…): no offset switch in the settings.
    await page.mouse.move(CENTER.x, CENTER.y) // reveal toolbars
    await page.getByTestId('settings').click()
    await expect(page.getByRole('switch', { name: 'Sfasa coppie' })).toHaveCount(0)
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
    await expect(page.getByTestId('book-progress')).toHaveText(/^Pagina 12 di 19/)
    // A started, unfinished volume also sits on the "Continua a leggere" shelf.
    const shelf = page.getByTestId('continue-shelf')
    await expect(shelf).toBeVisible()
    await expect(shelf.getByRole('button', { name: 'Continua manga-vol-01' })).toContainText('Pagina 12 di 19')
    // The header search narrows the grid by title.
    await page.getByTestId('library-search').fill('nessuno')
    await expect(page.getByTestId('book-card')).toHaveCount(0)
    await expect(page.getByText('Nessun volume corrisponde alla ricerca.')).toBeVisible()
    await page.getByTestId('library-search').fill('manga')
    await expect(page.getByTestId('book-card')).toHaveCount(1)
  })

  test('CBR: lists and extracts pages through the unrar worker, wide page alone', async ({ page }) => {
    await page.goto('/')
    const statuses = await importBooks(page, ['stored-book.cbr'])
    expect(statuses).toEqual(['Importato'])
    await expect(page.locator('[data-testid=book-card]')).toContainText(/cbr/i)
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
    await expect(stage).toHaveCSS('background-color', 'rgb(233, 231, 226)') // light appearance stage token
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
    const bounds = await page.getByTestId('reader').evaluate((element) => {
      const box = element.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, height: box.height, viewport: window.visualViewport?.height ?? window.innerHeight }
    })
    expect(bounds.top).toBeCloseTo(0, 0)
    expect(bounds.bottom).toBeCloseTo(bounds.viewport, 0)
    expect(bounds.height).toBeCloseTo(bounds.viewport, 0)
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
    await expect(page.getByRole('heading', { name: 'Mangadana' })).toBeVisible()
    await expect(page.getByTestId('book-card')).toHaveCount(1)
    await openBook(page, 'short-book')
    await expect(label(page)).toHaveText('1')
    await context.setOffline(false)
  })
})
