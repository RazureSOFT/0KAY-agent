import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { validatePoc, verdictLine } from './validate.js'

// The three-state verdict is the whole point: "we could not reach it" must never
// come back as "fixed", which is how a scan reports a clean bill of health for an
// app it never touched.

async function withServer<T>(handler: (req: any, res: any) => void, run: (base: string) => Promise<T>): Promise<T> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    server.close()
  }
}

test('a PoC that reproduces the behaviour is reproduced', async () => {
  await withServer((req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<script>alert(document.cookie)</script>')
  }, async (base) => {
    const verdict = await validatePoc({
      target: 'reflected XSS on /search',
      request: { url: `${base}/search?q=<script>` },
      expect: { statusIn: [200], bodyContains: ['<script>alert(document.cookie)'] },
    })
    assert.equal(verdict.conclusion, 'reproduced')
    assert.ok(verdict.evidence)
    assert.equal(verdict.evidence?.status, 200)
    assert.match(verdictLine(verdict, 'xss'), /REPRODUCED/)
  })
})

test('the same PoC against a fixed target is fixed, with the reason', async () => {
  await withServer((req, res) => {
    res.end('&lt;script&gt;alert(1)&lt;/script&gt;')
  }, async (base) => {
    const verdict = await validatePoc({
      target: 'reflected XSS on /search',
      request: { url: `${base}/search?q=x` },
      expect: { bodyContains: ['<script>alert(document.cookie)'] },
    })
    assert.equal(verdict.conclusion, 'fixed')
    assert.match(verdict.reason, /body has/)
  })
})

test('an unreachable target is cannot_confirm, never fixed', async () => {
  const verdict = await validatePoc(
    {
      target: 'api',
      request: { url: 'http://127.0.0.1:1/nope' },
      expect: { statusIn: [200] },
    },
    { timeoutMs: 3000 },
  )
  assert.equal(verdict.conclusion, 'cannot_confirm')
  assert.match(verdict.reason, /request failed/)
  assert.match(verdictLine(verdict), /CANNOT CONFIRM/)
})

test('a status mismatch is fixed; an unexpected extra is reported', async () => {
  await withServer((req, res) => {
    res.statusCode = 403
    res.end('forbidden')
  }, async (base) => {
    const verdict = await validatePoc({
      target: 'open redirect',
      request: { url: `${base}/redirect` },
      expect: { statusIn: [301, 302] },
    })
    assert.equal(verdict.conclusion, 'fixed')
    assert.match(verdict.reason, /status 403/)
  })
})

test('bodyAbsent passes when the marker is gone', async () => {
  await withServer((req, res) => res.end('all good'), async (base) => {
    const verdict = await validatePoc({
      target: 'error disclosure',
      request: { url: `${base}/` },
      expect: { bodyAbsent: ['stack trace'] },
    })
    assert.equal(verdict.conclusion, 'reproduced')
  })
})

test('a PoC with no expectation proves nothing', async () => {
  const verdict = await validatePoc({
    target: 'x',
    request: { url: 'http://127.0.0.1:1/' },
    expect: {},
  })
  assert.equal(verdict.conclusion, 'cannot_confirm')
  assert.match(verdict.reason, /no expectation/)
})

test('a redirect is observed, not followed', async () => {
  await withServer((req, res) => {
    if (req.url === '/start') {
      res.statusCode = 302
      res.setHeader('Location', '/elsewhere')
      res.end()
      return
    }
    res.end('landed')
  }, async (base) => {
    const verdict = await validatePoc({
      target: 'open redirect',
      request: { url: `${base}/start` },
      expect: { statusIn: [302], bodyAbsent: ['landed'] },
    })
    assert.equal(verdict.conclusion, 'reproduced')
  })
})
