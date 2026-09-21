// Renders the brand assets that are not the icons (those are in public/icons/, SVG + PNG exports)
// with headless Chromium, which Playwright already provides as a dev dependency:
//
//   public/splash/<w>x<h>-{light,dark}.png   iOS startup images, one per iPad size and orientation
//   public/brand/social-preview.png          1280×640 card for Open Graph and the GitHub social preview
//   public/brand/wordmark-{light,dark}.png   README header, transparent, 2×
//   public/favicon.ico                       16, 32 and 48 px tiles for the browsers that do not take an
//                                            SVG favicon (Safari) and for everything that asks for /favicon.ico
//   public/icons/mask-icon.svg               Safari pinned-tab mask (monochrome, 16×16 viewBox)
//
// The crown is read from src/components/crown.json (the same path the app draws); text is set in
// Inter, the typeface in the app's font stack after the system fonts, fetched once from the
// fontsource package on jsDelivr and cached under node_modules/.cache.
//
//   node scripts/make-brand-assets.mjs [splash] [social] [wordmark] [favicon]     (default: everything; Node 22+)

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync, inflateSync } from 'node:zlib'
import { chromium } from '@playwright/test'
import crown from '../src/components/crown.json' with { type: 'json' }
import devices from './splash-devices.json' with { type: 'json' }

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public')
const fontCache = join(root, 'node_modules', '.cache', 'mangadana-brand')

const APP_NAME = 'Mangadana'
const DOMAIN = 'manga-dana.com'
const TAGLINE = 'Lettore di manga e fumetti per iPad, in super risoluzione'

// Design tokens (src/index.css): ink on ivory in the light appearance, bone on near-black in the dark.
const THEMES = {
  light: { bg: '#f7f7f4', fg: '#26251e', fg2: 'rgba(38, 37, 30, 0.62)', fg3: 'rgba(38, 37, 30, 0.42)' },
  dark: { bg: '#14120b', fg: '#edecec', fg2: 'rgba(237, 236, 236, 0.62)', fg3: 'rgba(237, 236, 236, 0.4)' },
}
/** Height of the crown on a startup image, in points (the same on every iPad). */
const SPLASH_CROWN_PT = 144

const FONT_FILES = { 400: 'inter-latin-400-normal.woff2', 600: 'inter-latin-600-normal.woff2' }
const FONT_CDN = 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.2.8/files/'

async function fontFaces() {
  await mkdir(fontCache, { recursive: true })
  const faces = []
  for (const [weight, file] of Object.entries(FONT_FILES)) {
    const path = join(fontCache, file)
    let bytes
    try {
      bytes = await readFile(path)
    } catch {
      const res = await fetch(FONT_CDN + file)
      if (!res.ok) throw new Error(`Inter ${weight}: HTTP ${res.status} from ${FONT_CDN + file}`)
      bytes = Buffer.from(await res.arrayBuffer())
      await writeFile(path, bytes)
    }
    faces.push(
      `@font-face{font-family:Inter;font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2')}`,
    )
  }
  return faces.join('\n')
}

const crownSvg = (px, color, extra = '') =>
  `<svg viewBox="${crown.viewBox}" width="${px}" height="${px}" style="display:block;${extra}" fill="${color}" aria-hidden="true"><path d="${crown.d}"/></svg>`

const page_ = (body, css) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden}
body{display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;-webkit-font-smoothing:antialiased}
${css}
</style></head><body>${body}</body></html>`

async function render(page, { width, height, html, omitBackground = false }) {
  await page.setViewportSize({ width, height })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  return indexedPng(await page.screenshot({ type: 'png', omitBackground }))
}

/** Above this many distinct colours the image is real artwork, not a mark on a background: left as is. */
const MAX_COLOURS = 512

/**
 * Chromium writes 8-bit truecolor PNGs; a flat background with one anti-aliased mark has at most a
 * few hundred colours, so the same image stored as an indexed PNG is 5–10× smaller. Images with
 * many more colours (the social card with its text) are returned unchanged.
 */
function indexedPng(png) {
  const chunks = []
  let pos = 8
  while (pos < png.length) {
    const length = png.readUInt32BE(pos)
    const type = png.toString('latin1', pos + 4, pos + 8)
    chunks.push({ type, data: png.subarray(pos + 8, pos + 8 + length) })
    pos += 12 + length
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR').data
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const colorType = ihdr[9]
  if (ihdr[8] !== 8 || ihdr[12] !== 0 || (colorType !== 2 && colorType !== 6)) return png
  const bpp = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const stride = width * bpp
  const pixels = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pixels.subarray(y * stride, (y + 1) * stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let predictor = 0
      if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[i] = (line[i] + predictor) & 0xff
    }
    prev = out
  }
  const keyAt = (o) => ((pixels[o] << 24) | (pixels[o + 1] << 16) | (pixels[o + 2] << 8) | (bpp === 4 ? pixels[o + 3] : 255)) >>> 0
  const counts = new Map()
  for (let o = 0; o < pixels.length; o += bpp) {
    const key = keyAt(o)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (counts.size > MAX_COLOURS) return png
  }
  // Anti-aliasing rounds the blend of two colours slightly differently along an edge, so a mark
  // can use ~280 colours: the rare ones (a handful of edge pixels) go to their nearest neighbour.
  const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key)
  const palette = new Map(byCount.slice(0, 256).map((key, index) => [key, index]))
  const channels = (key) => [key >>> 24, (key >>> 16) & 0xff, (key >>> 8) & 0xff, key & 0xff]
  const paletteChannels = byCount.slice(0, 256).map(channels)
  for (const key of byCount.slice(256)) {
    const c = channels(key)
    let best = 0
    let bestDistance = Infinity
    paletteChannels.forEach((p, index) => {
      const distance = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2 + (p[3] - c[3]) ** 2
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    })
    palette.set(key, best)
  }
  const indexed = Buffer.alloc(height * (width + 1))
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) indexed[y * (width + 1) + 1 + x] = palette.get(keyAt(y * stride + x * bpp))
  }
  const size = Math.min(palette.size, 256)
  const plte = Buffer.alloc(size * 3)
  const trns = Buffer.alloc(size)
  let transparent = false
  for (const [key, index] of palette) {
    if (byCount.indexOf(key) >= 256) continue
    plte[index * 3] = (key >>> 24) & 0xff
    plte[index * 3 + 1] = (key >>> 16) & 0xff
    plte[index * 3 + 2] = (key >>> 8) & 0xff
    trns[index] = key & 0xff
    if (trns[index] !== 255) transparent = true
  }
  const header = Buffer.from(ihdr)
  header[9] = 3
  const chunk = (type, data) => {
    const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typeAndData))
    return Buffer.concat([length, typeAndData, crc])
  }
  return Buffer.concat([
    png.subarray(0, 8),
    chunk('IHDR', header),
    chunk('PLTE', plte),
    ...(transparent ? [chunk('tRNS', trns)] : []),
    chunk('IDAT', deflateSync(indexed, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function splash(page) {
  const dir = join(publicDir, 'splash')
  await mkdir(dir, { recursive: true })
  let count = 0
  for (const device of devices) {
    for (const [w, h] of [
      [device.width, device.height],
      [device.height, device.width],
    ]) {
      const width = w * device.scale
      const height = h * device.scale
      for (const [scheme, t] of Object.entries(THEMES)) {
        const crownPx = SPLASH_CROWN_PT * device.scale
        // A touch above the geometric centre, where the eye expects a lone mark.
        const html = page_(crownSvg(crownPx, t.fg, `margin-bottom:${Math.round(height * 0.06)}px`), `body{background:${t.bg}}`)
        const png = await render(page, { width, height, html })
        await writeFile(join(dir, `${width}x${height}-${scheme}.png`), png)
        count++
      }
    }
  }
  console.log(`splash: ${count} images in public/splash/`)
}

async function social(page, fonts) {
  const t = THEMES.dark
  const html = page_(
    `<div class="card">
      ${crownSvg(168, t.fg)}
      <div class="name">${APP_NAME}</div>
      <div class="tagline">${TAGLINE}</div>
      <div class="domain">${DOMAIN}</div>
    </div>`,
    `${fonts}
    body{background:${t.bg}}
    .card{display:flex;flex-direction:column;align-items:center;text-align:center;padding-bottom:12px}
    .name{margin-top:34px;font-size:92px;line-height:1;font-weight:600;letter-spacing:-0.035em;color:${t.fg}}
    .tagline{margin-top:24px;font-size:30px;line-height:1.3;font-weight:400;letter-spacing:-0.005em;color:${t.fg2}}
    .domain{margin-top:44px;font-size:17px;line-height:1;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:${t.fg3}}`,
  )
  const dir = join(publicDir, 'brand')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'social-preview.png'), await render(page, { width: 1280, height: 640, html }))
  console.log('social: public/brand/social-preview.png (1280×640)')
}

async function wordmark(page, fonts) {
  const dir = join(publicDir, 'brand')
  await mkdir(dir, { recursive: true })
  for (const [scheme, t] of Object.entries(THEMES)) {
    const html = page_(
      `<div class="lockup">${crownSvg(120, t.fg)}<div class="name">${APP_NAME}</div></div>`,
      `${fonts}
      body{background:transparent}
      .lockup{display:flex;align-items:center;gap:30px}
      .name{font-size:96px;line-height:1;font-weight:600;letter-spacing:-0.035em;color:${t.fg};padding-bottom:6px}`,
    )
    const png = await render(page, { width: 720, height: 160, html, omitBackground: true })
    await writeFile(join(dir, `wordmark-${scheme}.png`), png)
  }
  console.log('wordmark: public/brand/wordmark-{light,dark}.png (720×160, transparent)')
}

/**
 * Ink tile with the bone crown, the design of public/icons/icon.svg, drawn at a given pixel size.
 * `stroke` (in the crown's 100-unit box) thickens the glyph's outline on both sides.
 */
function tileSvg(px, { crownFraction, radiusFraction, stroke = 0 }) {
  const box = 512
  const scale = (box * crownFraction) / 100
  const tx = (box - 100 * scale) / 2
  // The crown sits a touch low in its box; the same nudge as the app icon.
  const ty = (box - 100 * scale) / 2 + box * 0.01
  const outline = stroke ? ` stroke="#f7f7f4" stroke-width="${stroke}" stroke-linejoin="round"` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" width="${px}" height="${px}" style="display:block">
    <rect width="${box}" height="${box}" rx="${Math.round(box * radiusFraction)}" fill="#26251e"/>
    <path transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})" d="${crown.d}" fill="#f7f7f4"${outline}/>
  </svg>`
}

/**
 * ICO container: a 6-byte header, one 16-byte directory entry per image, then the images. PNG
 * payloads are accepted by every current browser and keep the file small.
 */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + 16 * images.length
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size === 256 ? 0 : size
    entry[1] = size === 256 ? 0 : size
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}

async function favicon(page) {
  // Larger than on the app icon: in a tab the crown needs most of the tile to stay a crown. At
  // 16 px the glyph's outline is under a pixel wide and smears to grey: a slightly thicker outline
  // keeps it a crown (a solid silhouette loses the three points and reads as a blob).
  const tiles = {
    16: { crownFraction: 0.88, radiusFraction: 0.19, stroke: 4 },
    32: { crownFraction: 0.8, radiusFraction: 0.19 },
    48: { crownFraction: 0.8, radiusFraction: 0.19 },
  }
  const images = []
  for (const [size, tile] of Object.entries(tiles).map(([k, v]) => [Number(k), v])) {
    const html = page_(tileSvg(size, tile), 'body{background:transparent;display:block}')
    images.push({ size, png: await render(page, { width: size, height: size, html, omitBackground: true }) })
  }
  await writeFile(join(publicDir, 'favicon.ico'), ico(images))
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <path transform="scale(0.16)" d="${crown.d}"/>
</svg>
`
  await writeFile(join(publicDir, 'icons', 'mask-icon.svg'), mask)
  console.log(`favicon: public/favicon.ico (16, 32, 48 px; ${ico(images).length} bytes), public/icons/mask-icon.svg`)
}

const wanted = new Set(process.argv.slice(2))
const all = wanted.size === 0
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const fonts = all || wanted.has('social') || wanted.has('wordmark') ? await fontFaces() : ''
  if (all || wanted.has('splash')) await splash(page)
  if (all || wanted.has('social')) await social(page, fonts)
  if (all || wanted.has('wordmark')) await wordmark(page, fonts)
  if (all || wanted.has('favicon')) await favicon(page)
} finally {
  await browser.close()
}
