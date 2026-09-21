// library code, any is fine
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';

import type { Context, HandlerMap, OpenAPIBackend } from './backend';
import type { DefinitionPlan } from './plan';
import type { Operation, ParsedRequest } from './router';
import type { ValidationResult } from './validation';

// alias Document to OpenAPIV3_1.Document
type Document = OpenAPIV3_1.Document | OpenAPIV3.Document;

/**
 * A short-lived, per-request context. A new RequestContext is created at the start of every
 * OpenAPIBackend.handleRequest call and discarded when the request completes.
 *
 * It carries everything that may only live for the duration of a single request:
 * - a consistent generation snapshot of the handler registries, taken when the request starts. Handlers
 *   registered while the request is being processed are not visible to this request; they take effect
 *   from the next request onwards.
 * - the immutable DefinitionPlan the request is processed against
 * - all mutable per-request state: the parsed request, the matched operation, Ajv validation results
 *   (including errors) and security handler results. None of these can leak into the next request, which
 *   makes concurrent handleRequest calls safe to interleave.
 *
 * The RequestContext itself is passed to handlers as the public Context object.
 *
 * @export
 * @class RequestContext
 */
export class RequestContext<D extends Document = Document> {
  /**
   * The OpenAPIBackend instance processing this request
   */
  public readonly api: OpenAPIBackend<D>;

  /**
   * The immutable compiled plan this request is processed against
   */
  public readonly plan: DefinitionPlan<D>;

  /**
   * Consistent snapshot of the operation/lifecycle handler registry for this request
   */
  public readonly handlers: Readonly<HandlerMap>;

  /**
   * Consistent snapshot of the security handler registry for this request
   */
  public readonly securityHandlers: Readonly<HandlerMap>;

  /**
   * Parsed request, populated during request handling
   */
  public request: ParsedRequest;

  /**
   * Matched operation, populated during routing
   */
  public operation: Operation<D>;

  /**
   * Ajv validation result for this request, populated during validation
   */
  public validation: ValidationResult;

  /**
   * Security handler results and authorized flag for this request
   */
  public security: { [name: string]: any };

  /**
   * Response returned by the operation handler, populated before postResponseHandler runs
   */
  public response: any;

  /**
   * Creates a RequestContext. Handler registries are snapshotted (shallow copy) at construction time so
   * the request observes a single consistent generation of the registry.
   *
   * @param opts - context options
   * @param {OpenAPIBackend} opts.api - the OpenAPIBackend instance processing the request
   * @param {DefinitionPlan} opts.plan - the immutable plan to process the request against
   * @param {HandlerMap} opts.handlers - the live operation handler registry to snapshot
   * @param {HandlerMap} opts.securityHandlers - the live security handler registry to snapshot
   */
  constructor(opts: {
    api: OpenAPIBackend<D>;
    plan: DefinitionPlan<D>;
    handlers: HandlerMap;
    securityHandlers: HandlerMap;
  }) {
    this.api = opts.api;
    this.plan = opts.plan;
    this.handlers = Object.freeze({ ...opts.handlers });
    this.securityHandlers = Object.freeze({ ...opts.securityHandlers });
  }

  /**
   * Returns this context as the public Context object passed to handlers
   *
   * @returns {Context}
   */
  public asContext(): Context<any, any, any, any, any, D> {
    return this as unknown as Context<any, any, any, any, any, D>;
  }
}
