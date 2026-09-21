/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Characterization tests pinning the existing lifecycle of OpenAPIBackend:
 * definition loading, handler registration, and the exact call order,
 * arguments and exception propagation of handleRequest.
 *
 * These tests intentionally describe CURRENT behavior so that the
 * DefinitionPlan / RequestContext refactoring can be verified against them.
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
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer' },
          },
        ],
      },
      post: { operationId: 'createPet', responses },
    },
  },
  components: {
    securitySchemes: {
      basicAuth: { type: 'http', scheme: 'basic' },
    },
  },
  security: [{ basicAuth: [] }],
};

const req = (overrides: Partial<Request> = {}): Request => ({
  method: 'get',
  path: '/pets',
  headers: {},
  ...overrides,
});

describe('lifecycle characterization', () => {
  describe('initialization', () => {
    test('handleRequest auto-initializes the instance', async () => {
      const api = new OpenAPIBackend({ definition });
      api.register('getPets', () => 'ok');
      expect(api.initialized).toBeFalsy();
      const res = await api.handleRequest(req());
      expect(res).toBe('ok');
      expect(api.initialized).toBe(true);
    });

    test('init registers constructor handlers and security handlers', async () => {
      const getPets = jest.fn(() => 'ok');
      const basicAuth = jest.fn(() => ({ user: 'u' }));
      const api = new OpenAPIBackend({
        definition,
        handlers: { getPets },
        securityHandlers: { basicAuth },
      });
      await api.init();
      expect(api.handlers['getPets']).toBe(getPets);
      expect(api.securityHandlers['basicAuth']).toBe(basicAuth);
    });

    test('init throws in strict mode for invalid documents and warns otherwise', async () => {
      const invalid: any = { invalid: 'not openapi' };
      await expect(new OpenAPIBackend({ definition: invalid, strict: true }).init()).rejects.toThrowError();

      const warn = console.warn;
      console.warn = jest.fn();
      const api = new OpenAPIBackend({ definition: invalid, strict: false });
      await api.init();
      expect(console.warn).toBeCalledTimes(1);
      console.warn = warn;
      expect(api.initialized).toBe(true);
      expect(api.router.getOperations()).toHaveLength(0);
    });
  });

  describe('handleRequest handler pipeline order', () => {
    test('calls handlers in lifecycle order with context and handlerArgs', async () => {
      const calls: string[] = [];
      const mk = (name: string, ret?: any) =>
        jest.fn((..._args: any[]) => {
          calls.push(name);
          return ret;
        });

      const api = new OpenAPIBackend({ definition });
      api.register({
        preRoutingHandler: mk('preRoutingHandler'),
        postRoutingHandler: mk('postRoutingHandler'),
        postSecurityHandler: mk('postSecurityHandler'),
        preOperationHandler: mk('preOperationHandler'),
        postResponseHandler: mk('postResponseHandler', 'postResponse'),
        getPets: mk('getPets', 'operationResponse'),
      });
      api.registerSecurityHandler('basicAuth', mk('security:basicAuth', { user: 'u' }));
      await api.init();

      const res = await api.handleRequest(req(), 'arg1', 'arg2');

      expect(calls).toEqual([
        'preRoutingHandler',
        'postRoutingHandler',
        'security:basicAuth',
        'postSecurityHandler',
        'preOperationHandler',
        'getPets',
        'postResponseHandler',
      ]);
      // postResponseHandler return value replaces the operation response
      expect(res).toBe('postResponse');

      // every handler receives (context, ...handlerArgs)
      const operationHandler = api.handlers['getPets'] as jest.Mock;
      const [context, ...rest] = operationHandler.mock.calls[0];
      expect(rest).toEqual(['arg1', 'arg2']);
      expect(context.api).toBe(api);
      expect(context.operation.operationId).toBe('getPets');
      expect(context.request.path).toBe('/pets');
      expect(context.security.authorized).toBe(true);
      expect(context.security.basicAuth).toEqual({ user: 'u' });
      expect(context.validation.valid).toBe(true);

      // postResponseHandler sees the operation response on the context
      const postResponseHandler = api.handlers['postResponseHandler'] as jest.Mock;
      expect(postResponseHandler.mock.calls[0][0].response).toBe('operationResponse');
    });

    test('notFound handler is called on routing failure after postRoutingHandler', async () => {
      const calls: string[] = [];
      const api = new OpenAPIBackend({ definition });
      api.register(
        'postRoutingHandler',
        jest.fn(() => void calls.push('postRoutingHandler')),
      );
      api.register(
        'notFound',
        jest.fn(() => (calls.push('notFound'), 'notFoundResponse')),
      );
      await api.init();

      const res = await api.handleRequest(req({ path: '/unknown' }));
      expect(calls).toEqual(['postRoutingHandler', 'notFound']);
      expect(res).toBe('notFoundResponse');
    });

    test('routing error propagates when no notFound handler is registered', async () => {
      const api = new OpenAPIBackend({ definition });
      await api.init();
      await expect(api.handleRequest(req({ path: '/unknown' }))).rejects.toThrowError(/^404/);
    });

    test('validationFail handler receives validation errors and short-circuits the operation handler', async () => {
      const operationHandler = jest.fn();
      const validationFail = jest.fn(() => 'validationFailResponse');
      const postResponseHandler = jest.fn((c: Context) => c.response);
      const api = new OpenAPIBackend({ definition });
      api.register({ getPets: operationHandler, validationFail, postResponseHandler });
      api.registerSecurityHandler('basicAuth', () => ({}));
      await api.init();

      const res = await api.handleRequest(req({ query: { limit: 'not-an-integer' } }));
      expect(validationFail).toBeCalledTimes(1);
      const context = (validationFail.mock.calls[0] as any[])[0] as Context;
      expect(context.validation.valid).toBe(false);
      expect(context.validation.errors?.length).toBeGreaterThan(0);
      expect(operationHandler).not.toBeCalled();
      // postResponseHandler still runs for the validationFail response
      expect(postResponseHandler).toBeCalledTimes(1);
      expect(res).toBe('validationFailResponse');
    });

    test('mockResponseForOperation returns examples and schema mocks', async () => {
      const api = new OpenAPIBackend({
        definition: {
          openapi: '3.1.0',
          info: { title: 'api', version: '1.0.0' },
          paths: {
            '/pets': {
              get: {
                operationId: 'getPets',
                responses: {
                  200: {
                    description: 'ok',
                    content: {
                      'application/json': {
                        schema: { type: 'object', properties: { id: { type: 'integer' } } },
                        examples: { first: { value: { id: 1 } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      await api.init();
      expect(api.mockResponseForOperation('getPets', { example: 'first' })).toEqual({
        status: 200,
        mock: { id: 1 },
      });
      const { status, mock } = api.mockResponseForOperation('getPets');
      expect(status).toBe(200);
      expect(typeof mock.id).toBe('number');
    });
  });

  describe('exception propagation', () => {
    test('operation handler exceptions propagate and skip postResponseHandler', async () => {
      const postResponseHandler = jest.fn();
      const api = new OpenAPIBackend({ definition });
      api.register('getPets', () => {
        throw new Error('boom');
      });
      api.register('postResponseHandler', postResponseHandler);
      api.registerSecurityHandler('basicAuth', () => ({}));
      await api.init();

      await expect(api.handleRequest(req())).rejects.toThrowError('boom');
      expect(postResponseHandler).not.toBeCalled();
    });

    test('security handler errors are captured as { error } results, not thrown', async () => {
      const unauthorizedHandler = jest.fn(() => 'unauthorized');
      const api = new OpenAPIBackend({ definition });
      api.register('unauthorizedHandler', unauthorizedHandler);
      api.register('getPets', () => 'ok');
      api.registerSecurityHandler('basicAuth', () => {
        throw new Error('auth exploded');
      });
      await api.init();

      const res = await api.handleRequest(req());
      expect(res).toBe('unauthorized');
      const context = (unauthorizedHandler.mock.calls[0] as any[])[0] as Context;
      expect(context.security.authorized).toBe(false);
      expect((context.security.basicAuth as any).error.message).toBe('auth exploded');
    });
  });
});
