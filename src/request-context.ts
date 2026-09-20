// library code, any is fine
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Context, Document, OpenAPIBackend } from './backend';
import { DefinitionPlan } from './plan';
import { HandlerSnapshot } from './handler-registry';
import { Operation, ParsedRequest, Request } from './router';
import { ValidationResult } from './validation';

/**
 * Results returned by security handlers for a single request.
 */
export interface SecurityHandlerResults {
  [name: string]: any;
}

/**
 * Short-lived, per-request mutable state.
 *
 * A fresh instance is created for every `handleRequest` call and never shared
 * or retained afterwards: Ajv errors, security handler results and the matched
 * operation live here and therefore cannot leak into the next request, even
 * under concurrent requests sharing the same {@link DefinitionPlan}.
 *
 * The public {@link Context} handed to handlers is built from this object,
 * while the plan (router/validators) and the handler generation snapshot stay
 * immutable for the duration of the request.
 *
 * @export
 * @class RequestContext
 */
export class RequestContext<D extends Document = Document> {
  /** Backend instance (kept for `context.api` compatibility). */
  public readonly api: OpenAPIBackend<D>;
  /** Immutable compiled plan this request is processed against. */
  public readonly plan: DefinitionPlan<D>;
  /** Consistent handler generation captured at request start. */
  public readonly handlers: HandlerSnapshot;
  /** Consistent security-handler generation captured at request start. */
  public readonly securityHandlers: HandlerSnapshot;
  /** Extra arguments passed to handleRequest, forwarded to every handler. */
  public readonly handlerArgs: any[];

  /** Parsed request; repopulated after routing/coercion. */
  public request: ParsedRequest<any, any, any, any, any>;
  /** Matched operation; undefined until routing succeeds. */
  public operation: Operation<D> | undefined;
  /** Per-request security handler results. */
  public security: SecurityHandlerResults | undefined;
  /** Per-request Ajv validation result. */
  public validation: ValidationResult | undefined;
  /** Operation return value, set before postResponseHandler. */
  public response: any;

  constructor(params: {
    api: OpenAPIBackend<D>;
    plan: DefinitionPlan<D>;
    handlers: HandlerSnapshot;
    securityHandlers: HandlerSnapshot;
    rawRequest: Request;
    handlerArgs: any[];
  }) {
    this.api = params.api;
    this.plan = params.plan;
    this.handlers = params.handlers;
    this.securityHandlers = params.securityHandlers;
    this.handlerArgs = params.handlerArgs;
    // initial parse before routing (no operation context yet)
    this.request = params.plan.router.parseRequest(params.rawRequest);
  }

  /**
   * Builds the public Context object passed to user handlers.
   */
  public toHandlerContext(): Context<any, any, any, any, any, D> {
    return {
      api: this.api,
      request: this.request,
      operation: this.operation as Operation<D>,
      validation: this.validation as ValidationResult,
      security: this.security as SecurityHandlerResults,
      response: this.response,
    };
  }
}
