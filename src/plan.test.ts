/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Tests for the DefinitionPlan / RequestContext lifecycle split:
 * - plan identity and caching
 * - atomic initialization with fallback to the previous plan
 * - handler registry generation snapshots per request
 * - per-request state isolation under concurrency
 */

import { OpenAPIBackend, Context } from './backend';
import { DefinitionPlanCache, computeDocumentKey, computePlanIdentity } from './plan';
import type { Request } from './router';
import { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';

const responses: OpenAPIV3.ResponsesObject & OpenAPIV3_1.ResponsesObject = {
  200: { description: 'ok' },
};

const meta = {
  openapi: '3.1.0',
  info: { title: 'api', version: '1.0.0' },
};

const petDefinition = (): OpenAPIV3_1.Document => ({
  ...meta,
  paths: {
    '/pets': {
      get: {
        operationId: 'getPets',
        responses,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
      },
    },
  },
  components: {
    securitySchemes: {
      basicAuth: { type: 'http', scheme: 'basic' },
    },
  },
  security: [{ basicAuth: [] }],
});

const getPets = (overrides: Partial<Request> = {}): Request => ({
  method: 'get',
  path: '/pets',
  headers: {},
  ...overrides,
});

describe('DefinitionPlan', () => {
  test('plan is frozen after init and exposes the route index', async () => {
    const api = new OpenAPIBackend({ definition: petDefinition() });
    await api.init();
    expect(Object.isFrozen(api.plan)).toBe(true);
    expect(Object.isFrozen(api.plan.operations)).toBe(true);
    expect(api.plan.operationsById.get('getPets')?.operationId).toBe('getPets');
    expect(api.plan.router).toBe(api.router);
    expect(api.plan.validator).toBe(api.validator);
  });

  test('same definition and options hit a shared plan cache; no global singleton by default', async () => {
    const planCache = new DefinitionPlanCache();
    const api1 = new OpenAPIBackend({ definition: petDefinition(), planCache });
    const api2 = new OpenAPIBackend({ definition: petDefinition(), planCache });
    await api1.init();
    await api2.init();
    // identical definition + identical compile options => shared compiled plan
    expect(api2.plan).toBe(api1.plan);
    expect(planCache.size).toBe(1);

    // without an explicitly shared cache, instances never share plans
    const apiA = new OpenAPIBackend({ definition: petDefinition() });
    const apiB = new OpenAPIBackend({ definition: petDefinition() });
    await apiA.init();
    await apiB.init();
    expect(apiA.plan).not.toBe(apiB.plan);
  });

  test('same document with different compile options does not share a plan', async () => {
    const planCache = new DefinitionPlanCache();
    const base = new OpenAPIBackend({ definition: petDefinition(), planCache });
    await base.init();

    const variants: Array<[string, any]> = [
      ['ajvOpts', { ajvOpts: { allErrors: true } }],
      ['customizeAjv', { customizeAjv: (ajv: any) => ajv }],
      ['coerceTypes', { coerceTypes: true }],
      ['quick (dereference strategy)', { quick: true }],
      ['apiRoot (document base)', { apiRoot: '/v1' }],
      ['validate', { validate: false }],
    ];
    for (const [, opts] of variants) {
      const api = new OpenAPIBackend({ definition: petDefinition(), planCache, ...opts });
      await api.init();
      expect(api.plan).not.toBe(base.plan);
      expect(api.plan.identity).not.toBe(base.plan.identity);
    }
    // every variant produced its own cache entry
    expect(planCache.size).toBe(1 + variants.length);

    // identical variants still share
    const again = new OpenAPIBackend({ definition: petDefinition(), planCache, coerceTypes: true });
    await again.init();
    expect(planCache.size).toBe(1 + variants.length);
  });

  test('plan identity is content-based, not reference-based', () => {
    const doc = petDefinition();
    const keyA = computeDocumentKey(doc);
    const keyB = computeDocumentKey(JSON.parse(JSON.stringify(doc)));
    expect(keyA).toBe(keyB);

    doc.paths!['/pets']!.get!.operationId = 'renamed';
    expect(computeDocumentKey(doc)).not.toBe(keyA);

    const identityComponents = {
      documentKey: keyA,
      apiRoot: '/',
      ignoreTrailingSlashes: true,
      validate: true,
      ajvOpts: {},
      coerceTypes: false,
      quick: false,
    };
    const base = computePlanIdentity(identityComponents);
    const withCustomizer = computePlanIdentity({ ...identityComponents, customizeAjv: (ajv: any) => ajv });
    expect(withCustomizer).not.toBe(base);
  });

  test('mutating the input document and re-initializing produces a fresh plan', async () => {
    const definition = petDefinition();
    const api = new OpenAPIBackend({ definition });
    await api.init();
    const firstPlan = api.plan;

    definition.paths!['/pets']!.post = { operationId: 'createPet', responses };
    await api.init();
    expect(api.plan).not.toBe(firstPlan);
    expect(api.plan.operationsById.has('createPet')).toBe(true);
  });

  test('recursive $ref schemas initialize and validate', async () => {
    const definition: OpenAPIV3_1.Document = {
      ...meta,
      paths: {
        '/nodes': {
          post: {
            operationId: 'createNode',
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Node' } },
              },
            },
            responses,
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
            },
          },
        },
      },
    };
    const seen: Context[] = [];
    const api = new OpenAPIBackend({ definition, strict: true });
    api.register('createNode', (c: Context) => {
      seen.push(c);
      return 'ok';
    });
    api.register('validationFail', (c: Context) => {
      seen.push(c);
      return 'invalid';
    });
    await api.init();

    const valid = await api.handleRequest({
      method: 'post',
      path: '/nodes',
      headers: { 'content-type': 'application/json' },
      body: { name: 'root', children: [{ name: 'leaf', children: [{ name: 'leaf2' }] }] },
    });
    expect(valid).toBe('ok');

    const invalid = await api.handleRequest({
      method: 'post',
      path: '/nodes',
      headers: { 'content-type': 'application/json' },
      body: { name: 'root', children: [{ children: [{ name: 1 }] }] },
    });
    expect(invalid).toBe('invalid');
    expect(seen[1].validation.valid).toBe(false);
    expect(seen[1].validation.errors?.length).toBeGreaterThan(0);
  });
});

describe('atomic initialization', () => {
  test('failed re-initialization keeps the previous plan serving requests (non-strict)', async () => {
    const definition = petDefinition();
    const api = new OpenAPIBackend({ definition });
    api.register('getPets', () => 'ok');
    api.registerSecurityHandler('basicAuth', () => ({}));
    await api.init();
    const goodPlan = api.plan;
    expect(await api.handleRequest(getPets())).toBe('ok');

    // corrupt the definition and re-initialize: the old plan must stay active
    const warn = console.warn;
    console.warn = jest.fn();
    (definition as any).paths = null;
    await api.init();
    expect(console.warn).toHaveBeenCalled();
    console.warn = warn;

    expect(api.plan).toBe(goodPlan);
    expect(api.router.getOperations()).toHaveLength(1);
    expect(await api.handleRequest(getPets())).toBe('ok');
  });

  test('failed re-initialization in strict mode rejects but keeps the old plan', async () => {
    const definition = petDefinition();
    const api = new OpenAPIBackend({ definition, strict: true });
    api.register('getPets', () => 'ok');
    api.registerSecurityHandler('basicAuth', () => ({}));
    await api.init();
    const goodPlan = api.plan;

    (definition as any).paths = null;
    await expect(api.init()).rejects.toThrowError();
    expect(api.plan).toBe(goodPlan);
    expect(await api.handleRequest(getPets())).toBe('ok');
  });

  test('schema compilation failure does not replace the previous plan', async () => {
    const definition = petDefinition();
    const api = new OpenAPIBackend({ definition });
    await api.init();
    const goodPlan = api.plan;

    const warn = console.warn;
    console.warn = jest.fn();
    // invalid JSON schema: Ajv fails to compile
    definition.paths!['/pets']!.get!.parameters = [
      { name: 'limit', in: 'query', schema: { type: 'not-a-type' } as any },
    ];
    await api.init();
    console.warn = warn;
    expect(api.plan).toBe(goodPlan);
  });
});

describe('handler registry generations', () => {
  test('handlers registered mid-request are not visible to the in-flight request', async () => {
    const api = new OpenAPIBackend({ definition: petDefinition() });
    api.registerSecurityHandler('basicAuth', () => ({}));
    const v1 = jest.fn(() => 'v1');
    const v2 = jest.fn(() => 'v2');
    const postResponseHandler = jest.fn(() => 'postResponse');
    api.register('getPets', () => {
      // mutate the registry while the request is being processed
      api.register('getPets', v2);
      api.register('postResponseHandler', postResponseHandler);
      return v1();
    });
    await api.init();

    // the in-flight request sees a single consistent generation: v1 runs, postResponseHandler does not
    expect(await api.handleRequest(getPets())).toBe('v1');
    expect(v2).not.toBeCalled();
    expect(postResponseHandler).not.toBeCalled();

    // the next request sees the new generation
    expect(await api.handleRequest(getPets())).toBe('postResponse');
    expect(v2).toBeCalledTimes(1);
    expect(postResponseHandler).toBeCalledTimes(1);
  });

  test('operation handler registered during preOperationHandler is not used for the same request', async () => {
    const api = new OpenAPIBackend({ definition: petDefinition() });
    api.registerSecurityHandler('basicAuth', () => ({}));
    api.register('notImplemented', () => 'notImplemented');
    api.register('preOperationHandler', () => {
      api.register('getPets', () => 'late-registered');
    });
    await api.init();

    expect(await api.handleRequest(getPets())).toBe('notImplemented');
    expect(await api.handleRequest(getPets())).toBe('late-registered');
  });

  test('security handlers registered mid-request are not visible to the in-flight request', async () => {
    const api = new OpenAPIBackend({ definition: petDefinition() });
    const seen: Context[] = [];
    api.register('preRoutingHandler', () => {
      api.registerSecurityHandler('basicAuth', () => ({ user: 'late' }));
    });
    api.register('getPets', (c: Context) => {
      seen.push(c);
      return 'ok';
    });
    await api.init();

    // first request: security handler registered mid-request is not used
    await api.handleRequest(getPets());
    expect(seen[0].security.basicAuth).toBeUndefined();
    expect(seen[0].security.authorized).toBe(false);

    // second request: new generation is visible
    await api.handleRequest(getPets());
    expect(seen[1].security.basicAuth).toEqual({ user: 'late' });
    expect(seen[1].security.authorized).toBe(true);
  });
});

describe('request context isolation', () => {
  test('parallel requests never observe each others security, validation or operation state', async () => {
    const api = new OpenAPIBackend({ definition: petDefinition() });
    const contexts: Context[] = [];
    api.registerSecurityHandler('basicAuth', (c: Context) => {
      const user = c.request.headers['x-user'];
      // simulate async auth work with varying latency to force interleaving
      return new Promise((resolve) => setTimeout(() => resolve({ user }), Math.random() * 10));
    });
    api.register('getPets', async (c: Context) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
      contexts.push(c);
      return { user: (c.security as any).basicAuth?.user, valid: c.validation.valid };
    });
    api.register('validationFail', (c: Context) => {
      contexts.push(c);
      return { user: (c.security as any).basicAuth?.user, valid: false };
    });
    await api.init();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        api.handleRequest(
          getPets({
            headers: { 'x-user': `user-${i}` },
            // every third request fails validation
            query: i % 3 === 0 ? { limit: 'not-an-integer' } : {},
          }),
        ),
      ),
    );

    // every response carries its own request's user and validation outcome
    results.forEach((res, i) => {
      expect(res.user).toBe(`user-${i}`);
      expect(res.valid).toBe(i % 3 !== 0);
    });

    // no context leaked state into another request
    expect(contexts).toHaveLength(50);
    expect(new Set(contexts).size).toBe(50);
    for (const c of contexts) {
      expect((c.security as any).basicAuth.user).toBe(c.request.headers['x-user']);
      if (c.validation.valid) {
        expect(c.validation.errors).toBeNull();
      } else {
        expect(c.validation.errors?.length).toBeGreaterThan(0);
      }
    }
  });

  test('per-request state does not leak into sequential requests', async () => {
    const api = new OpenAPIBackend({ definition: petDefinition() });
    const validations: Context['validation'][] = [];
    api.registerSecurityHandler('basicAuth', () => ({}));
    api.register('getPets', (c: Context) => {
      validations.push(c.validation);
      return 'ok';
    });
    api.register('validationFail', (c: Context) => {
      validations.push(c.validation);
      return 'invalid';
    });
    await api.init();

    expect(await api.handleRequest(getPets({ query: { limit: 'bad' } }))).toBe('invalid');
    expect(await api.handleRequest(getPets())).toBe('ok');
    expect(validations[0].valid).toBe(false);
    expect(validations[1].valid).toBe(true);
    expect(validations[1].errors).toBeNull();
    expect(validations[0]).not.toBe(validations[1]);
  });
});
