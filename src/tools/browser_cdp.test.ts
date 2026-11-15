import test from 'node:test'
import assert from 'node:assert/strict'
import { browserAvailable, renderWithBrowser, probeScript, PROBE_PROPERTIES } from './browser_driver.js'
import { findCdpExecutable } from './browser_cdp.js'

// A craft check is only as honest as its weakest backend. `browserAvailable()`
// used to say yes when the Playwright *CLI* was on PATH, even with neither the
// Node module nor the Python package importable — and the check then degraded
// into the static-markup approximation without anyone noticing. These tests pin
// the answer to the question each backend actually has to answer, and pin the
// CDP backend's shape to the one the other two report.

const dataUrl = (html: string): string => `data:text/html;base64,${Buffer.from(html).toString('base64')}`

const sample = `<html><body style="margin:0">
  <header style="background:#2563eb;color:#fff;padding:18px;font-size:20px">Ship faster</header>
  <main style="padding:24px"><p>A card with copy</p><button aria-expanded="false">Menu</button></main>
</body></html>`

test('browserAvailable answers whether a page can actually be rendered', async () => {
  // No playwright module, no python package — only a local Chromium. The old
  // implementation returned true here for the wrong reason (a CLI on PATH) and
  // returned false on the machines that only had the browser.
  const executable = await findCdpExecutable()
  const available = await browserAvailable()
  if (executable) assert.equal(available, true, 'a local browser is a usable backend')
})

test('a page rendered over CDP reports the same shape as the other backends', async () => {
  if (!(await findCdpExecutable())) return;
  const result = await renderWithBrowser({
    url: dataUrl(sample),
    timeoutMs: 25_000,
    viewport: { width: 390, height: 900 },
    actions: [{ type: 'probe', probe: { label: 'base' } }],
  })
  assert.ok(result, 'the local browser must be able to render')
  assert.equal(result!.via, 'cdp')
  assert.equal(result!.rendered, true)
  assert.ok(result!.html.includes('Ship faster'))
  assert.equal(result!.probes.length, 1)
  assert.equal(result!.probes[0].label, 'base')
  assert.ok(result!.probes[0].data.elements.length >= 3)
})

test('the narrow width really lays the page out at 390, not at the 980px fallback', async () => {
  if (!(await findCdpExecutable())) return;
  const widths: number[] = []
  for (const width of [390, 1280]) {
    const result = await renderWithBrowser({
      url: dataUrl(sample),
      timeoutMs: 25_000,
      viewport: { width, height: 900 },
      actions: [{ type: 'probe', probe: { label: 'base' } }],
    })
    assert.ok(result)
    const header = (result!.probes[0].data.elements as any[]).find((row) => row.tag === 'header')
    assert.ok(header, 'the measured header must be in the element list')
    widths.push(header.rect.width)
  }
  assert.deepEqual(widths, [390, 1280])
})

test('an opened menu is visible as a state change, not just as a click that worked', async () => {
  if (!(await findCdpExecutable())) return;
  const result = await renderWithBrowser({
    url: dataUrl(sample.replace('</body>', `<script>document.querySelector('button').onclick = (e) => e.currentTarget.setAttribute('aria-expanded','true')</script></body>`)),
    timeoutMs: 25_000,
    viewport: { width: 1280, height: 900 },
    actions: [
      { type: 'probe', probe: { label: 'base' } },
      { type: 'probe', probe: { label: 'menu-open', interactions: [{ type: 'click', selector: 'button' }, { type: 'wait', ms: 150 }] } },
    ],
  })
  assert.ok(result)
  const closed = result!.probes.find((row) => row.label === 'base')!
  const opened = result!.probes.find((row) => row.label === 'menu-open')!
  const stateOf = (probe: any): string => String(probe.data.states.find((row: any) => row.tag === 'button')?.expanded ?? '')
  assert.equal(stateOf(closed), 'false')
  assert.equal(stateOf(opened), 'true', 'the interaction must be replayed before reading')
})

test('a click that finds no control is reported, not silently skipped', async () => {
  if (!(await findCdpExecutable())) return;
  const result = await renderWithBrowser({
    url: dataUrl(sample),
    timeoutMs: 25_000,
    viewport: { width: 1280, height: 900 },
    actions: [{ type: 'probe', probe: { label: 'menu-open', interactions: [{ type: 'click', selector: 'nav a' }] } }],
  })
  assert.ok(result)
  assert.ok(result!.probeErrors?.some((row) => row.label === 'menu-open'))
  assert.equal(result!.probes.length, 1, 'the read still happens after a failed interaction')
})

test('a screenshot is a real PNG with the requested width', async () => {
  if (!(await findCdpExecutable())) return;
  const result = await renderWithBrowser({
    url: dataUrl(sample),
    timeoutMs: 25_000,
    viewport: { width: 390, height: 900 },
    actions: [{ type: 'screenshot' }],
  })
  assert.ok(result)
  const dataUrlShot = result!.screenshots.find((row) => row.dataUrl)?.dataUrl || ''
  assert.ok(dataUrlShot.startsWith('data:image/png;base64,'))
  const buffer = Buffer.from(dataUrlShot.split(',')[1], 'base64')
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG')
  assert.equal(buffer.readUInt32BE(16), 390, 'the capture must be the width that was asked for')
})

test('the probe reads the visual properties the comparison depends on', async () => {
  const script = probeScript()
  for (const property of ['background-color', 'font-size', 'padding', 'border-radius', 'box-shadow']) {
    assert.ok((PROBE_PROPERTIES as readonly string[]).includes(property), property)
    assert.ok(script.includes(property), `${property} must be read in the page`)
  }
})