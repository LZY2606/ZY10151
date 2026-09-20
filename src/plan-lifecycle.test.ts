/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the refactored lifecycle:
 *  - immutable, shareable DefinitionPlan via DefinitionPlanCache
 *  - cache identity (document content + ajvOpts + customizeAjv + baseUri +
 *    dereference strategy + format-affecting options)
 *  - atomic init with old-plan fallback on failure
 *  - handler generation snapshots (no mid-request version flips)
 *  - concurrent request isolation
 *  - recursive $ref documents
 */
import * as path from 'path';
import { OpenAPIBackend, Context, DefinitionPlanCache } from './backend';
import { stableHash, buildDefinitionPlan, PlanBuildOptions } from './plan';
import type { Request } from './router';
import { OpenAPIV3_1 } from 'openapi-types';

const testsDir = path.join(__dirname, '..', '__tests__');
const circularRefPath = path.join(testsDir, 'resources', 'refs.openapi.json');

const responses = { '200': { description: 'ok' } };

function makeDoc(n = 1): OpenAPIV3_1.Document {
  const pathKey = n === 1 ? '/pets' : '/pets/' + n;
  return {
    openapi: '3.1.0',
    info: { title: 'api', version: '1.0.0' },
    paths: {
      [pathKey]: {
        get: {
          operationId: 'getPets',
          responses,
        },
      },
    },
  } as OpenAPIV3_1.Document;
}

const validDoc: OpenAPIV3_1.Document = {
  openapi: '3.1.0',
  info: { title: 'api', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'getPets',
        responses,
      },
    },
  },
};

const getRequest: Request = { method: 'get', path: '/pets', headers: {} };

function baseOptions(over: Partial<PlanBuildOptions> = {}): PlanBuildOptions {
  return {
    inputDocument: validDoc,
    apiRoot: '/',
    ignoreTrailingSlashes: true,
    validateDefinition: true,
    buildValidator: true,
    ajvOpts: {},
    lazyCompileValidators: false,
    coerceTypes: false,
    dereferenceStrategy: 'async-object',
    ...over,
  };
}

describe('DefinitionPlan immutability', () => {
  test('plan surface is frozen after a successful build', async () => {
    const plan = await buildDefinitionPlan(baseOptions());
    expect(Object.isFrozen(plan)).toBe(true);
    expect(() => {
      (plan as any).router = {};
    }).toThrow();
  });

  test('plan construction dereferences without mutating the caller document', async () => {
    const docWithRef: any = {
      openapi: '3.0.3',
      info: { title: 'circular', version: '1.0.0' },
      paths: {
        '/trees': {
          post: {
            operationId: 'createTree',
            responses: { '200': { description: 'ok' } },
            requestBody: { $ref: '#/components/requestBodies/CreateTree' },
          },
        },
      },
      components: {
        requestBodies: {
          CreateTree: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BinTree' } } },
          },
        },
        schemas: {
          BinTree: {
            type: 'object',
            properties: { value: { type: 'number' } },
          },
        },
      },
    };
    const refBefore = JSON.stringify(docWithRef.paths['/trees'].post.requestBody);
    await buildDefinitionPlan(baseOptions({ inputDocument: docWithRef }));
    // source object keeps its $ref and is untouched
    expect(JSON.stringify(docWithRef.paths['/trees'].post.requestBody)).toBe(refBefore);
    expect(docWithRef.paths['/trees'].post.requestBody.$ref).toBe('#/components/requestBodies/CreateTree');
  });
});

describe('DefinitionPlanCache identity', () => {
  test('identical definition + options share one compiled plan', async () => {
    const cache = new DefinitionPlanCache();
    const a = new OpenAPIBackend({ definition: validDoc, planCache: cache });
    const b = new OpenAPIBackend({ definition: validDoc, planCache: cache });
    await Promise.all([a.init(), b.init()]);
    expect(cache.size).toBe(1);
    expect((a as any).currentPlan).toBe((b as any).currentPlan);
  });

  test('deep-equal separate document objects share one plan', async () => {
    const cache = new DefinitionPlanCache();
    const a = new OpenAPIBackend({ definition: makeDoc(1), planCache: cache });
    const b = new OpenAPIBackend({ definition: makeDoc(1), planCache: cache });
    await Promise.all([a.init(), b.init()]);
    expect(cache.size).toBe(1);
  });

  test('different document content produces separate plans', async () => {
    const cache = new DefinitionPlanCache();
    const a = new OpenAPIBackend({ definition: makeDoc(1), planCache: cache });
    const b = new OpenAPIBackend({ definition: makeDoc(2), planCache: cache });
    await Promise.all([a.init(), b.init()]);
    expect(cache.size).toBe(2);
  });

  test('different ajvOpts produce separate plans', async () => {
    const cache = new DefinitionPlanCache();
    const a = new OpenAPIBackend({ definition: validDoc, planCache: cache, ajvOpts: { allErrors: true } });
    const b = new OpenAPIBackend({ definition: validDoc, planCache: cache, ajvOpts: { allErrors: false } });
    await Promise.all([a.init(), b.init()]);
    expect(cache.size).toBe(2);
  });

  test('a custom Ajv option (format) participates in identity', async () => {
    const cache = new DefinitionPlanCache();
    const a = new OpenAPIBackend({
      definition: validDoc,
      planCache: cache,
      ajvOpts: { formats: { phone: /^\d+$/ } },
    });
    const b = new OpenAPIBackend({
      definition: validDoc,
      planCache: cache,
      ajvOpts: { formats: { email: /^.+@.+$/ } },
    });
    await Promise.all([a.init(), b.init()]);
    expect(cache.size).toBe(2);
  });

  test('customizeAjv function identity participates in cache key', async () => {
    const cache = new DefinitionPlanCache();
    const customizerA = ((ajv: any) => ajv) as any;
    const customizerB = ((ajv: any) => ajv) as any;
    const a = new OpenAPIBackend({ definition: validDoc, planCache: cache, customizeAjv: customizerA });
    const b = new OpenAPIBackend({ definition: validDoc, planCache: cache, customizeAjv: customizerB });
    const c = new OpenAPIBackend({ definition: validDoc, planCache: cache, customizeAjv: customizerA });
    await Promise.all([a.init(), b.init(), c.init()]);
    // A and C share, B does not
    expect(cache.size).toBe(2);
  });

  test('same customizeAjv function across calls still hits the cache', async () => {
    const cache = new DefinitionPlanCache();
    const customizer = ((ajv: any) => ajv) as any;
    const a = new OpenAPIBackend({ definition: validDoc, planCache: cache, customizeAjv: customizer });
    await a.init();
    const b = new OpenAPIBackend({ definition: validDoc, planCache: cache, customizeAjv: customizer });
    await b.init();
    expect(cache.size).toBe(1);
  });

  test('different baseUri produces separate plans', async () => {
    const cache = new DefinitionPlanCache();
    const a = new OpenAPIBackend({ definition: validDoc, planCache: cache, baseUri: '/srv/a' });
    const b = new OpenAPIBackend({ definition: validDoc, planCache: cache, baseUri: '/srv/b' });
    await Promise.all([a.init(), b.init()]);
    expect(cache.size).toBe(2);
  });

  test('different dereference strategy (quick) produces a separate plan', async () => {
    const cache = new DefinitionPlanCache();
    const a = new OpenAPIBackend({ definition: validDoc, planCache: cache });
    const b = new OpenAPIBackend({ definition: validDoc, planCache: cache, quick: true });
    await Promise.all([a.init(), b.init()]);
    expect(cache.size).toBe(2);
  });

  test('validate:false and coerceTypes produce separate plans', async () => {
    const cache = new DefinitionPlanCache();
    const a = new OpenAPIBackend({ definition: validDoc, planCache: cache, validate: false });
    const b = new OpenAPIBackend({ definition: validDoc, planCache: cache, coerceTypes: true });
    const c = new OpenAPIBackend({ definition: validDoc, planCache: cache });
    await Promise.all([a.init(), b.init(), c.init()]);
    expect(cache.size).toBe(3);
  });

  test('path vs object definition do not share plans', async () => {
    const cache = new DefinitionPlanCache();
    const a = new OpenAPIBackend({ definition: circularRefPath, planCache: cache });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const circularObject = require(circularRefPath);
    const b = new OpenAPIBackend({ definition: circularObject, planCache: cache });
    await Promise.all([a.init(), b.init()]);
    expect(cache.size).toBe(2);
  });

  test('concurrent initializations with identical input are de-duplicated', async () => {
    const cache = new DefinitionPlanCache();
    const backends = Array.from({ length: 4 }, () => new OpenAPIBackend({ definition: validDoc, planCache: cache }));
    await Promise.all(backends.map((api) => api.init()));
    expect(cache.size).toBe(1);
  });

  test('there is no module-level singleton cache between unshared backends', async () => {
    const a = new OpenAPIBackend({ definition: validDoc });
    const b = new OpenAPIBackend({ definition: validDoc });
    await Promise.all([a.init(), b.init()]);
    expect((a as any).planCache).not.toBe((b as any).planCache);
    expect((a as any).currentPlan).not.toBe((b as any).currentPlan);
  });

  test('stableHash is order-insensitive and cycle-safe', () => {
    const h1 = stableHash({ a: 1, b: { c: 2, d: 3 } });
    const h2 = stableHash({ b: { d: 3, c: 2 }, a: 1 });
    expect(h1).toBe(h2);
    const cyclic: any = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => stableHash(cyclic)).not.toThrow();
    expect(stableHash(cyclic)).toBe(stableHash(cyclic));
  });
});

describe('atomic initialization with fallback', () => {
  test('strict init failure rejects and leaves backend uninitialized', async () => {
    const invalid: any = { invalid: 'not openapi' };
    const api = new OpenAPIBackend({ definition: invalid, strict: true });
    await expect(api.init()).rejects.toThrowError();
    expect(api.initialized).toBeFalsy();
  });

  test('non-strict init failure still serves zero routes and can be retried', async () => {
    const warn = console.warn;
    console.warn = jest.fn();
    const invalid: any = { invalid: 'not openapi' };
    const api = new OpenAPIBackend({ definition: invalid, strict: false });
    await api.init();
    expect(console.warn).toBeCalled();
    expect(api.initialized).toBe(true);
    expect(api.getOperations()).toHaveLength(0);
    console.warn = warn;

    // recover by pointing at a valid definition, then init again
    (api as any).inputDocument = validDoc;
    await api.init();
    expect(api.getOperations()).toHaveLength(1);
  });

  test('re-init failure in strict mode keeps the old plan usable', async () => {
    const api = new OpenAPIBackend({ definition: validDoc, strict: true });
    api.register('getPets', () => 'old-plan-response');
    await api.init();
    const oldPlan = (api as any).currentPlan;

    // swap in a broken definition; init must reject without dropping the plan
    (api as any).inputDocument = { broken: true } as any;
    await expect(api.init()).rejects.toThrowError();
    expect((api as any).currentPlan).toBe(oldPlan);
    expect(api.initialized).toBe(true);

    const res = await api.handleRequest(getRequest);
    expect(res).toBe('old-plan-response');
  });

  test('schema compile failure in strict mode keeps serving the old plan', async () => {
    const api = new OpenAPIBackend({ definition: validDoc, strict: true });
    await api.init();
    const oldPlan = (api as any).currentPlan;

    // A document that passes OpenAPI structural validation but contains an
    // Ajv-incompatible construct will fail validator compilation.
    const broken: any = {
      openapi: '3.1.0',
      info: { title: 'api', version: '1.0.0' },
      paths: {
        '/broken': {
          get: {
            operationId: 'getBroken',
            responses: { '200': { description: 'ok' } },
            parameters: [
              {
                name: 'p',
                in: 'query',
                schema: { type: 'string', invalidAjvKeyword: 123 },
              },
            ],
          },
        },
      },
    };
    (api as any).inputDocument = broken;
    // Ajv strict:false tolerates unknown keywords, so force a compile error by
    // reusing an ajv option that Ajv itself rejects at compile time is hard;
    // instead emulate via malformed schema type which Ajv throws on.
    broken.paths['/broken'].get.parameters[0].schema = { type: 42 };
    await expect(api.init()).rejects.toThrow();
    expect((api as any).currentPlan).toBe(oldPlan);
    expect(api.getOperations()).toHaveLength(1);
  });

  test('strict init failure rejects while concurrent requests keep using the old plan', async () => {
    const api = new OpenAPIBackend({ definition: validDoc, strict: true });
    api.register('getPets', () => 'still-here');
    await api.init();
    const oldPlan = (api as any).currentPlan;

    (api as any).inputDocument = { broken: true } as any;
    const attempts = await Promise.allSettled([
      api.init(),
      // already initialized -> the request ignores the broken re-init and is
      // served atomically by the previous plan
      api.handleRequest(getRequest),
    ]);
    expect(attempts[0].status).toBe('rejected');
    expect(attempts[1].status).toBe('fulfilled');
    if (attempts[1].status === 'fulfilled') {
      expect(attempts[1].value).toBe('still-here');
    }

    // the old plan survived the failed concurrent initializations
    expect((api as any).currentPlan).toBe(oldPlan);

    // restore a good definition: recovery succeeds and requests are served
    (api as any).inputDocument = validDoc;
    expect(await api.handleRequest(getRequest)).toBe('still-here');
  });
});

describe('handler generation snapshots', () => {
  test('a handler registered mid-request is not seen by the same request', async () => {
    const api = new OpenAPIBackend({ definition: validDoc });
    await api.init();

    let resolveGate: () => void = () => undefined;
    const gate = new Promise<void>((res) => {
      resolveGate = res;
    });

    // first request blocks inside its operation handler
    api.register('getPets', (async () => {
      // while blocked, register a replacement "next generation" handler
      api.register('getPets', () => 'second-generation');
      resolveGate();
      return 'first-generation';
    }) as any);

    const first = api.handleRequest(getRequest);
    await gate;
    const firstResult = await first;
    expect(firstResult).toBe('first-generation');

    // the later request sees the new generation
    const secondResult = await api.handleRequest(getRequest);
    expect(secondResult).toBe('second-generation');
  });

  test('snapshots are frozen and advance the generation only on change', async () => {
    const api = new OpenAPIBackend({ definition: validDoc }) as any;
    await api.init();
    const s1 = api.handlerRegistry.snapshot();
    const s2 = api.handlerRegistry.snapshot();
    expect(s1.generation).toBe(s2.generation);
    expect(Object.isFrozen(s1.handlers)).toBe(true);

    api.register('getPets', () => 'x');
    const s3 = api.handlerRegistry.snapshot();
    expect(s3.generation).toBe(s1.generation + 1);
    // old snapshot stays intact
    expect(s1.handlers['getPets']).toBeUndefined();
    expect(s3.handlers['getPets']).toBeDefined();
  });

  test('direct mutation of api.handlers bumps generation too', async () => {
    const api = new OpenAPIBackend({ definition: validDoc }) as any;
    await api.init();
    const before = api.handlerRegistry.snapshot().generation;
    api.handlers['getPets'] = () => 'direct';
    const after = api.handlerRegistry.snapshot().generation;
    expect(after).toBeGreaterThan(before);
    expect(api.handlers['getPets']()).toBe('direct');
  });

  test('a bulk register commits one generation', async () => {
    const api = new OpenAPIBackend({ definition: validDoc }) as any;
    await api.init();
    const before = api.handlerRegistry.snapshot().generation;
    api.register({ getPets: () => 'a' });
    const afterOne = api.handlerRegistry.snapshot().generation;
    api.register({ getPets: () => 'b', notFound: () => 'c' });
    const afterBulk = api.handlerRegistry.snapshot().generation;
    expect(afterOne - before).toBe(1);
    expect(afterBulk - afterOne).toBe(1);
  });
});

describe('concurrent request isolation', () => {
  test('parallel requests get independent contexts, validation and security state', async () => {
    const doc: OpenAPIV3_1.Document = {
      openapi: '3.1.0',
      info: { title: 'api', version: '1.0.0' },
      paths: {
        '/pets/{id}': {
          get: {
            operationId: 'getPetById',
            responses,
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          },
        },
      },
      components: { securitySchemes: { basicAuth: { type: 'http', scheme: 'basic' } } },
      security: [{ basicAuth: [] }],
    };
    const api = new OpenAPIBackend({ definition: doc });
    const seenContexts: Context[] = [];
    api.register('getPetById', ((c: Context) => {
      seenContexts.push(c);
    }) as any);
    api.register('validationFail', ((c: Context) => {
      seenContexts.push(c);
    }) as any);

    // barrier: hold both security handlers until they are both in flight,
    // guaranteeing interleaving of the two requests on shared state
    let arrived = 0;
    let releaseBarrier: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    api.registerSecurityHandler('basicAuth', ((c: Context) => {
      const id = String((c.request.params as any).id);
      arrived++;
      if (arrived === 2) {
        releaseBarrier();
      }
      return barrier.then(() => `auth-${id}`);
    }) as any);

    await api.init();

    await Promise.all([
      api.handleRequest({ method: 'get', path: '/pets/1', headers: {} }),
      api.handleRequest({ method: 'get', path: '/pets/bad', headers: {} }),
    ]);

    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[0]).not.toBe(seenContexts[1]);
    // neither context carries the other's validation errors
    const valids = seenContexts.map((c) => c.validation?.valid);
    expect(valids.sort()).toEqual([false, true]);
    const auths = seenContexts.map((c) => c.security?.basicAuth).sort();
    expect(auths).toEqual(['auth-1', 'auth-bad']);
  });

  test('parallel requests do not share a plan or recompile validators', async () => {
    const cache = new DefinitionPlanCache();
    const api = new OpenAPIBackend({ definition: validDoc, planCache: cache });
    const plans: any[] = [];
    api.register('getPets', ((c: Context) => {
      plans.push((c.api as any).currentPlan);
    }) as any);
    await api.init();
    await Promise.all(Array.from({ length: 8 }, () => api.handleRequest(getRequest)));
    expect(new Set(plans).size).toBe(1);
    expect(cache.size).toBe(1);
  });
});

describe('recursive $ref documents', () => {
  test('initializes, routes and validates a circular document (object input)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const doc = require(circularRefPath);
    const api = new OpenAPIBackend({ definition: doc, strict: true });
    await api.init();
    expect(
      api
        .getOperations()
        .map((op) => op.operationId)
        .sort(),
    ).toEqual(['createTree', 'getTrees']);

    // valid recursive body
    const ok = api.validateRequest(
      {
        method: 'post',
        path: '/trees',
        headers: { 'content-type': 'application/json' },
        body: { value: 1, left: { value: 2 } },
      },
      'createTree',
    );
    expect(ok.valid).toBe(true);

    // invalid recursive body (value must be a number)
    const bad = api.validateRequest(
      { method: 'post', path: '/trees', headers: { 'content-type': 'application/json' }, body: { value: 'nope' } },
      'createTree',
    );
    expect(bad.valid).toBe(false);
  });

  test('initializes the same circular document from its file path', async () => {
    const api = new OpenAPIBackend({ definition: circularRefPath, strict: true });
    await api.init();
    expect(api.getOperations()).toHaveLength(2);
  });

  test('two object instances of the circular document share a plan', async () => {
    const cache = new DefinitionPlanCache();
    const a = new OpenAPIBackend({ definition: require(circularRefPath), planCache: cache });
    const b = new OpenAPIBackend({ definition: require(circularRefPath), planCache: cache });
    await Promise.all([a.init(), b.init()]);
    expect(cache.size).toBe(1);
  });
});
