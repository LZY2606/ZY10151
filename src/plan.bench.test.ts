/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Benchmark-style regression tests guarding the DefinitionPlan lifecycle:
 * - initialization compiles Ajv validators exactly once per unique definition + options
 * - re-initializing with an identical definition and options hits the plan cache
 * - hot requests never trigger recompilation of validators
 */

import { OpenAPIBackend } from './backend';
import { DefinitionPlanCache } from './plan';
import type { Request } from './router';
import { OpenAPIV3_1 } from 'openapi-types';

const OPERATION_COUNT = 120;

/**
 * Deterministically generates a large OpenAPI definition with OPERATION_COUNT operations, each with
 * path/query parameters, a request body and response schemas.
 */
function buildLargeDefinition(): OpenAPIV3_1.Document {
  const paths: OpenAPIV3_1.PathsObject = {};
  for (let i = 0; i < OPERATION_COUNT; i++) {
    paths[`/resources-${i % 12}/{id}/items-${i}`] = {
      get: {
        operationId: `getItem${i}`,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
          { name: 'filter', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'name'],
                  properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
            headers: {
              'x-request-id': { schema: { type: 'string' } },
            },
          },
        },
      },
      post: {
        operationId: `createItem${i}`,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', minLength: 1 },
                  price: { type: 'number', minimum: 0 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'created' } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'large-api', version: '1.0.0' },
    paths,
  };
}

describe('initialization and hot-request performance guards', () => {
  jest.setTimeout(60000);

  test('validators compile once per plan; cached re-init and hot requests do not recompile', async () => {
    let compileCount = 0;
    const countingCustomizer = (ajv: any) => {
      const compile = ajv.compile.bind(ajv);
      ajv.compile = (...args: any[]) => {
        compileCount++;
        return compile(...args);
      };
      return ajv;
    };

    const planCache = new DefinitionPlanCache();
    const definition = buildLargeDefinition();

    // cold init: compiles all validators
    const coldStart = Date.now();
    const api = new OpenAPIBackend({ definition, planCache, customizeAjv: countingCustomizer });
    api.register('getItem0', () => 'ok');
    await api.init();
    const coldInitMs = Date.now() - coldStart;
    const compiledAfterColdInit = compileCount;
    expect(compiledAfterColdInit).toBeGreaterThan(OPERATION_COUNT);

    // re-init with identical definition + options on a new instance: cache hit, zero recompiles
    const cachedStart = Date.now();
    const api2 = new OpenAPIBackend({
      definition: buildLargeDefinition(),
      planCache,
      customizeAjv: countingCustomizer,
    });
    await api2.init();
    const cachedInitMs = Date.now() - cachedStart;
    expect(api2.plan).toBe(api.plan);
    expect(compileCount).toBe(compiledAfterColdInit);
    expect(cachedInitMs).toBeLessThan(coldInitMs);

    // hot requests: no validator compilation per request
    const request: Request = { method: 'get', path: '/resources-0/1/items-0', headers: {}, query: { limit: '10' } };
    const hotStart = Date.now();
    const HOT_REQUESTS = 300;
    for (let i = 0; i < HOT_REQUESTS; i++) {
      await api.handleRequest(request);
    }
    const hotMs = Date.now() - hotStart;
    expect(compileCount).toBe(compiledAfterColdInit);
    // 300 hot requests must be far cheaper than a full cold init (no recompilation)
    expect(hotMs).toBeLessThan(Math.max(coldInitMs, 1000));

    // eslint-disable-next-line no-console
    process.stdout.write(
      `\n[bench] operations=${OPERATION_COUNT} validators=${compiledAfterColdInit} ` +
        `coldInit=${coldInitMs}ms cachedInit=${cachedInitMs}ms hot=${HOT_REQUESTS}req/${hotMs}ms\n`,
    );
  });
});
