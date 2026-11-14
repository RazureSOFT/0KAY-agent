import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EmbeddingError, createEmbedder, embedInBatches, extractVectors, indexerName, resolveEmbeddingConfig } from './embeddings.js';

/**
 * A stand-in Core, so provider discovery can be controlled exactly.
 *
 * The agent reaches Core's `/api/providers/credentials`, which in turn goes out
 * through the egress guard. Standing up the endpoint (the trick the pentest tests
 * already use) keeps the client's code path intact.
 */
async function withCore<T>(
  providers: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(providers));
    void req;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const saved = { CORE_HTTP_ADDR: process.env.CORE_HTTP_ADDR, CORE_HTTP: process.env.CORE_HTTP };
  process.env.CORE_HTTP_ADDR = `http://127.0.0.1:${port}`;
  delete process.env.CORE_HTTP;
  try {
    return await run();
  } finally {
    if (saved.CORE_HTTP_ADDR === undefined) delete process.env.CORE_HTTP_ADDR;
    else process.env.CORE_HTTP_ADDR = saved.CORE_HTTP_ADDR;
    if (saved.CORE_HTTP !== undefined) process.env.CORE_HTTP = saved.CORE_HTTP;
    server.close();
  }
}

/** A stand-in embeddings endpoint. */
async function withEmbeddings<T>(
  handler: (body: any, res: any) => void,
  run: (url: string) => Promise<T>,
): Promise<T> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    handler(body, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const EMBEDDING_PROVIDER = {
  providers: [{
    id: 'p-embed', provider: 'openai', kind: 'embedding', base_url: 'https://api.example/v1',
    api_key: 'sk-x', models: ['text-embedding-3-small'], default_model: 'text-embedding-3-small', enabled: true,
  }],
  default_provider_id: 'p-embed',
};

test('an embedding provider is found and resolved', async () => {
  await withCore(EMBEDDING_PROVIDER, async () => {
    const config = await resolveEmbeddingConfig();
    assert.ok(config);
    assert.equal(config.model, 'text-embedding-3-small');
    assert.equal(config.baseUrl, 'https://api.example/v1');
    assert.equal(config.apiKey, 'sk-x');
  });
});

test('with no embedding provider, the answer is undefined rather than a throw', async () => {
  // This is the most important behaviour in the module: the caller falls back to
  // the lexical index, and an exception here would make a working feature look
  // broken.
  await withCore({ providers: [{ id: 'l', kind: 'llm', base_url: 'https://x/v1', models: ['gpt-4'], enabled: true }] }, async () => {
    assert.equal(await resolveEmbeddingConfig(), undefined);
  });
});

test('an LLM provider listing an embed-shaped model is not an embeddings provider', async () => {
  // Sending text to a chat endpoint expecting vectors is how a confusing 400
  // reaches a user.
  await withCore({ providers: [{ id: 'l', kind: 'llm', base_url: 'https://x/v1', models: ['text-embedding-3-small'], enabled: true }] }, async () => {
    assert.equal(await resolveEmbeddingConfig(), undefined);
  });
});

test('a disabled embedding provider is ignored', async () => {
  await withCore({ providers: [{ ...EMBEDDING_PROVIDER.providers[0], enabled: false }] }, async () => {
    assert.equal(await resolveEmbeddingConfig(), undefined);
  });
});

test('an incomplete provider record is not used', async () => {
  // A base URL or model with nothing in it means a request that cannot succeed;
  // falling back is better than a guaranteed failure.
  await withCore({ providers: [{ id: 'p', kind: 'embedding', base_url: '', models: ['m'], enabled: true }] }, async () => {
    assert.equal(await resolveEmbeddingConfig(), undefined);
  });
  await withCore({ providers: [{ id: 'p', kind: 'embedding', base_url: 'https://x/v1', models: [], enabled: true }] }, async () => {
    assert.equal(await resolveEmbeddingConfig(), undefined);
  });
});

test('a named model is preferred when it is offered', async () => {
  await withCore({
    providers: [{
      id: 'p', kind: 'embedding', base_url: 'https://x/v1', models: ['small', 'large'], default_model: 'small', enabled: true,
    }],
  }, async () => {
    assert.equal((await resolveEmbeddingConfig(undefined, { model: 'large' }))?.model, 'large');
    // A model it does not offer falls back to the provider's default rather than
    // sending a request that is guaranteed to 404.
    assert.equal((await resolveEmbeddingConfig(undefined, { model: 'nonexistent' }))?.model, 'small');
  });
});

test('core being unreachable reads as no embedding provider, not as a config error', async () => {
  // Reporting the wrong reason sends somebody looking in the wrong place.
  const saved = process.env.CORE_HTTP_ADDR;
  process.env.CORE_HTTP_ADDR = 'http://127.0.0.1:1';
  try {
    assert.equal(await resolveEmbeddingConfig(), undefined);
  } finally {
    if (saved === undefined) delete process.env.CORE_HTTP_ADDR;
    else process.env.CORE_HTTP_ADDR = saved;
  }
});

test('an embedder posts the OpenAI shape and reads the vectors back', async () => {
  let seen: any;
  await withEmbeddings((body, res) => {
    seen = body;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: body.input.map((_: string, i: number) => ({ embedding: [i, 1], index: i })) }));
  }, async (url) => {
    const embedder = createEmbedder({ baseUrl: url, apiKey: 'k', model: 'm', provider: 'test' });
    const vectors = await embedder.embed(['a', 'b']);
    assert.deepEqual(seen, { model: 'm', input: ['a', 'b'] });
    assert.deepEqual(vectors, [[0, 1], [1, 1]]);
  });
});

test('the api key travels as a bearer header', async () => {
  let auth: string | undefined;
  const server = createServer((req, res) => {
    auth = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end('{"data":[{"embedding":[1],"index":0}]}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  try {
    const embedder = createEmbedder({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'secret', model: 'm', provider: 'test' });
    await embedder.embed(['x']);
    assert.equal(auth, 'Bearer secret');
  } finally {
    server.close();
  }
});

test('vectors are ordered by the index the provider sent', async () => {
  // The index is not guaranteed to be in order, and a mis-attributed vector is a
  // hit on the wrong file.
  await withEmbeddings((_body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ embedding: [2], index: 1 }, { embedding: [1], index: 0 }] }));
  }, async (url) => {
    const embedder = createEmbedder({ baseUrl: url, apiKey: '', model: 'm', provider: 'test' });
    assert.deepEqual(await embedder.embed(['a', 'b']), [[1], [2]]);
  });
});

test('extractVectors accepts a bare array too', () => {
  assert.deepEqual(extractVectors([[1, 2], [3, 4]], 2), [[1, 2], [3, 4]]);
});

test('extractVectors refuses what it cannot attribute', () => {
  // A response that cannot be matched to the inputs must not be guessed at.
  assert.equal(extractVectors({ data: [{ embedding: [1], index: 0 }] }, 2), undefined, 'too few vectors');
  assert.equal(extractVectors({ data: [{ embedding: [], index: 0 }] }, 1), undefined, 'empty vector');
  assert.equal(extractVectors({ data: [{ embedding: [1, NaN], index: 0 }] }, 1), undefined, 'non-finite');
  assert.equal(extractVectors({ data: [{ embedding: [1], index: 5 }] }, 1), undefined, 'index out of range');
  assert.equal(extractVectors({ data: [{ embedding: [1], index: 0 }, { embedding: [2], index: 0 }] }, 2), undefined, 'duplicate index');
  assert.equal(extractVectors({ nonsense: true }, 1), undefined);
});

test('a 4xx is not retryable and a 5xx is', () => {
  // The distinction decides whether the caller retries or falls back.
  assert.equal(new EmbeddingError('x', false).retryable, false);
  assert.equal(new EmbeddingError('x', true).retryable, true);
});

test('a 400 from the endpoint is reported with the provider named', async () => {
  await withEmbeddings((_body, res) => {
    res.statusCode = 400;
    res.end('{"error":"unknown model"}');
  }, async (url) => {
    const embedder = createEmbedder({ baseUrl: url, apiKey: '', model: 'm', provider: 'myprovider' });
    await assert.rejects(() => embedder.embed(['x']), (error: Error) => {
      assert.match(error.message, /myprovider/);
      assert.match(error.message, /400/);
      assert.match(error.message, /unknown model/);
      return true;
    });
  });
});

test('an unreachable endpoint is retryable', async () => {
  const embedder = createEmbedder({ baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'm', provider: 'p' });
  await assert.rejects(() => embedder.embed(['x']), (error: Error) => {
    assert.ok(error instanceof EmbeddingError);
    assert.equal(error.retryable, true);
    return true;
  });
});

test('an empty input list makes no request', async () => {
  let called = false;
  await withEmbeddings((_body, res) => { called = true; res.end('{}') }, async (url) => {
    const embedder = createEmbedder({ baseUrl: url, apiKey: '', model: 'm', provider: 'p' });
    assert.deepEqual(await embedder.embed([]), []);
    assert.equal(called, false);
  });
});

test('batching splits a large corpus and keeps the order', async () => {
  const embedder = {
    model: 'm',
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => [Number(text)]);
    },
  };
  const texts = Array.from({ length: 10 }, (_, i) => String(i));
  const { vectors, model } = await embedInBatches(embedder, texts, 3);
  assert.equal(model, 'm');
  assert.deepEqual(vectors.map((vector) => vector[0]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a batch that returns the wrong count fails loudly', async () => {
  // Silently pairing the wrong vectors with the wrong chunks puts a hit on the
  // wrong file.
  const embedder = { model: 'm', async embed(): Promise<number[][]> { return [[1]] } };
  await assert.rejects(() => embedInBatches(embedder, ['a', 'b'], 2), /returned 1 vectors for 2 inputs/);
});

test('the indexer name distinguishes backends and models', () => {
  // Switching backend has to invalidate the cache, or the index mixes vectors
  // from incompatible spaces and ranks them against each other.
  assert.equal(indexerName('lexical'), 'lexical-tfidf-1');
  assert.equal(indexerName('embedding', 'small'), 'embedding:small');
  assert.notEqual(indexerName('embedding', 'small'), indexerName('embedding', 'large'));
  assert.notEqual(indexerName('embedding', 'small'), indexerName('lexical'));
});