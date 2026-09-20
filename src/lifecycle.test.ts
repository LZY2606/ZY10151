/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Characterization tests for the OpenAPIBackend request lifecycle.
 *
 * These tests pin down the externally observable behaviour of
 *   - handler invocation order and arguments
 *   - notFound / methodNotAllowed / validationFail / mock response handling
 *   - postResponseHandler timing, arguments and exception propagation
 *   - per-request context isolation
 *
 * before the internal DefinitionPlan / RequestContext refactor. They must keep
 * passing after the refactor.
 */
import { OpenAPIBackend, Context } from './backend';
import type { Request } from './router';
import { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';

const responses: OpenAPIV3.ResponsesObject & OpenAPIV3_1.ResponsesObject = {
  200: { description: 'ok' },
};

const definition: OpenAPIV3_1.Document = {
  openapi: '3.1.0',
  info: { title: 'api', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'getPets',
        responses,
      },
      post: {
        operationId: 'createPet',
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/pets/{id}': {
      get: {
        operationId: 'getPetById',
        responses,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'kind', in: 'query', schema: { type: 'string' } },
        ],
      },
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
    },
  },
  components: {
    securitySchemes: {
      basicAuth: { type: 'http', scheme: 'basic' },
    },
  },
  security: [{ basicAuth: [] }],
};

const getRequest: Request = { method: 'get', path: '/pets', headers: {} };

describe('lifecycle characterization', () => {
  describe('handler timing and arguments', () => {
    let api: OpenAPIBackend<OpenAPIV3_1.Document>;
    let order: string[];
    beforeEach(async () => {
      api = new OpenAPIBackend({ definition });
      order = [];
      const track = (name: string) => async () => {
        order.push(name);
      };
      api.register('getPets', jest.fn(track('operationHandler')) as any);
      api.register('notFound', jest.fn(track('notFoundHandler')) as any);
      api.register('methodNotAllowed', jest.fn(track('methodNotAllowedHandler')) as any);
      api.register('unauthorizedHandler', jest.fn(track('unauthorizedHandler')) as any);
      api.register('validationFail', jest.fn(track('validationFailHandler')) as any);
      api.register('notImplemented', jest.fn(track('notImplementedHandler')) as any);
      api.register('preRoutingHandler', jest.fn(track('preRoutingHandler')) as any);
      api.register('postRoutingHandler', jest.fn(track('postRoutingHandler')) as any);
      api.register('postSecurityHandler', jest.fn(track('postSecurityHandler')) as any);
      api.register('preOperationHandler', jest.fn(track('preOperationHandler')) as any);
      api.register('postResponseHandler', jest.fn(track('postResponseHandler')) as any);
      api.registerSecurityHandler('basicAuth', () => true);
      await api.init();
    });

    test('runs lifecycle handlers in the documented order on success', async () => {
      await api.handleRequest(getRequest);
      expect(order).toEqual([
        'preRoutingHandler',
        'postRoutingHandler',
        'postSecurityHandler',
        'preOperationHandler',
        'operationHandler',
        'postResponseHandler',
      ]);
    });

    test('preRouting/postRouting run before notFound on unmatched routes', async () => {
      await api.handleRequest({ method: 'get', path: '/nope', headers: {} });
      expect(order).toEqual(['preRoutingHandler', 'postRoutingHandler', 'notFoundHandler', 'postResponseHandler']);
    });

    test('preRouting/postRouting run before methodNotAllowed', async () => {
      await api.handleRequest({ method: 'delete', path: '/pets', headers: {} });
      expect(order).toEqual([
        'preRoutingHandler',
        'postRoutingHandler',
        'methodNotAllowedHandler',
        'postResponseHandler',
      ]);
    });

    test('postSecurity -> unauthorizedHandler when auth fails', async () => {
      api.registerSecurityHandler('basicAuth', () => false);
      await api.handleRequest(getRequest);
      expect(order).toEqual([
        'preRoutingHandler',
        'postRoutingHandler',
        'postSecurityHandler',
        'unauthorizedHandler',
        'postResponseHandler',
      ]);
    });

    test('validationFail replaces the operation handler for invalid requests', async () => {
      await api.handleRequest({ method: 'get', path: '/pets/not-an-int', headers: {} });
      expect(order).toContain('validationFailHandler');
      expect(order).not.toContain('operationHandler');
      expect(order[order.length - 1]).toBe('postResponseHandler');
    });

    test('extra handleRequest arguments are passed to every lifecycle handler', async () => {
      const seen: string[] = [];
      api.register('preRoutingHandler', ((_c: Context, arg: string) => seen.push('pre:' + arg)) as any);
      api.register('getPets', ((_c: Context, arg: string) => seen.push('op:' + arg)) as any);
      api.register('postResponseHandler', ((_c: Context, arg: string) => seen.push('post:' + arg)) as any);
      await api.handleRequest(getRequest, 'x');
      expect(seen).toEqual(['pre:x', 'op:x', 'post:x']);
    });

    test('postResponseHandler receives the operation return value and its result is returned', async () => {
      api.register('getPets', (() => 'op-response') as any);
      let postContext: Context | undefined;
      api.register('postResponseHandler', ((c: Context) => {
        postContext = c;
        return 'post-response';
      }) as any);
      const res = await api.handleRequest(getRequest);
      expect(postContext?.response).toBe('op-response');
      expect(res).toBe('post-response');
    });

    test('postResponseHandler is skipped and the operation error propagates when handler throws', async () => {
      const err = new Error('boom-operation');
      api.register('getPets', (() => {
        throw err;
      }) as any);
      await expect(api.handleRequest(getRequest)).rejects.toThrow('boom-operation');
      expect(order).not.toContain('postResponseHandler');
    });

    test('postResponseHandler is skipped when notFound handler throws', async () => {
      api.register('notFound', (() => {
        throw new Error('boom-404');
      }) as any);
      await expect(api.handleRequest({ method: 'get', path: '/nope', headers: {} })).rejects.toThrow('boom-404');
      expect(order).not.toContain('postResponseHandler');
    });
  });

  describe('error routes without handlers', () => {
    test('rejects with 404 when no notFound handler is registered', async () => {
      const api = new OpenAPIBackend({ definition, strict: true });
      await api.init();
      await expect(api.handleRequest({ method: 'get', path: '/nope', headers: {} })).rejects.toThrow(/^404-notFound/);
    });

    test('rejects with 501 when no operation/notImplemented handler is registered', async () => {
      const api = new OpenAPIBackend({ definition, strict: false });
      await api.init();
      await expect(api.handleRequest(getRequest)).rejects.toThrow(/^501-notImplemented/);
    });
  });

  describe('per-request state isolation', () => {
    test('each request receives its own context with its own validation result', async () => {
      const api = new OpenAPIBackend({ definition });
      const contexts: Context[] = [];
      api.register('getPetById', ((c: Context) => {
        contexts.push(c);
      }) as any);
      api.register('validationFail', ((c: Context) => {
        contexts.push(c);
      }) as any);
      await api.init();

      await api.handleRequest({ method: 'get', path: '/pets/1', headers: {} });
      expect(contexts[0].validation?.valid).toBe(true);
      expect(contexts[0].validation?.errors).toBeNull();

      await api.handleRequest({ method: 'get', path: '/pets/not-an-int', headers: {} });
      expect(contexts[1]).not.toBe(contexts[0]);
      expect(contexts[1].validation?.valid).toBe(false);
      expect(contexts[1].validation?.errors?.length).toBeGreaterThan(0);

      // re-running a valid request must not see the previous request's errors
      await api.handleRequest({ method: 'get', path: '/pets/2', headers: {} });
      expect(contexts[2]).not.toBe(contexts[1]);
      expect(contexts[2].validation?.valid).toBe(true);
      expect(contexts[2].validation?.errors).toBeNull();
    });

    test('security results do not leak between requests', async () => {
      const api = new OpenAPIBackend({ definition });
      const seen: any[] = [];
      api.register('getPets', ((c: Context) => seen.push(c.security)) as any);
      await api.init();

      api.registerSecurityHandler('basicAuth', () => 'first-result');
      await api.handleRequest(getRequest);
      api.registerSecurityHandler('basicAuth', () => 'second-result');
      await api.handleRequest(getRequest);

      expect(seen[0].basicAuth).toBe('first-result');
      expect(seen[1].basicAuth).toBe('second-result');
      expect(seen[0]).not.toBe(seen[1]);
    });
  });

  describe('auto-initialization', () => {
    test('handleRequest auto-initializes when init() was not called', async () => {
      const api = new OpenAPIBackend({ definition });
      api.register('getPets', (() => 'ok') as any);
      const res = await api.handleRequest(getRequest);
      expect(api.initialized).toBe(true);
      expect(res).toBe('ok');
    });

    test('concurrent first requests share one initialization and both succeed', async () => {
      const api = new OpenAPIBackend({ definition });
      api.register('getPets', ((c: Context) => c.operation.operationId) as any);
      const [a, b] = await Promise.all([api.handleRequest(getRequest), api.handleRequest(getRequest)]);
      expect(a).toBe('getPets');
      expect(b).toBe('getPets');
    });
  });
});
