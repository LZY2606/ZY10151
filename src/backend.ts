// library code, any is fine
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as _ from 'lodash';
import type { Options as AjvOpts } from 'ajv';
import OpenAPISchemaValidator from 'openapi-schema-validator';
import { parse as parseJSONSchema } from './refparser';

import { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';
import { mock, SchemaLike } from 'mock-json-schema';

import { OpenAPIRouter, Request, ParsedRequest, Operation, UnknownParams } from './router';
import { OpenAPIValidator, ValidationResult, AjvCustomizer } from './validation';
import OpenAPIUtils from './utils';
import {
  DefinitionPlan,
  DefinitionPlanCache,
  PlanBuildOptions,
  DereferenceStrategy,
  parsePlanDocument,
  buildDefinitionPlan,
} from './plan';
import { HandlerRegistry } from './handler-registry';
import { RequestContext, SecurityHandlerResults } from './request-context';

// alias Document to OpenAPIV3_1.Document
export type Document = OpenAPIV3_1.Document | OpenAPIV3.Document;
export type PickVersionElement<D extends Document, V30, V31> = D extends OpenAPIV3_1.Document ? V31 : V30;

// alias SecurityRequirement
export type SecurityRequirement = OpenAPIV3_1.SecurityRequirementObject | OpenAPIV3.SecurityRequirementObject;

export type { DefinitionPlan, PlanBuildOptions, DereferenceStrategy } from './plan';
export { DefinitionPlanCache } from './plan';
export type { HandlerSnapshot } from './handler-registry';
export { RequestContext } from './request-context';

/**
 * Security / Authorization context for requests
 */
interface SecurityHandlerResultsInternal {
  [name: string]: any;
}
export interface SecurityContext extends SecurityHandlerResultsInternal {
  authorized: boolean;
}

/**
 * Passed context built for request. Passed as first argument for all handlers.
 */
export interface Context<
  RequestBody = any,
  Params = UnknownParams,
  Query = UnknownParams,
  Headers = UnknownParams,
  Cookies = UnknownParams,
  D extends Document = Document,
> {
  api: OpenAPIBackend<D>;
  request: ParsedRequest<RequestBody, Params, Query, Headers, Cookies>;
  operation: Operation<D>;
  validation: ValidationResult;
  security: SecurityHandlerResults;
  response: any;
}

/**
 * A handler for an operation with request Context and passed arguments from handleRequest
 */
export type Handler<
  RequestBody = any,
  Params = UnknownParams,
  Query = UnknownParams,
  Headers = UnknownParams,
  Cookies = UnknownParams,
  D extends Document = Document,
> = (context: Context<RequestBody, Params, Query, Headers, Cookies, D>, ...args: any[]) => any | Promise<any>;

/**
 * Map of operation handlers
 */
export type HandlerMap = { [operationId: string]: Handler | undefined };

export type ContextPredicate = (context: Context, ...args: any[]) => boolean;
/**
 * @deprecated Use ContextPredicate instead.
 */
export type BoolPredicate = ContextPredicate;

/**
 * The different possibilities for set matching.
 *
 * @enum {string}
 */
export enum SetMatchType {
  Any = 'any',
  Superset = 'superset',
  Subset = 'subset',
  Exact = 'exact',
}

/**
 * Constructor options
 *
 * @export
 * @interface Options
 */
export interface Options<D extends Document = Document> {
  definition: D | string;
  apiRoot?: string;
  strict?: boolean;
  quick?: boolean;
  validate?: boolean | ContextPredicate;
  ajvOpts?: AjvOpts;
  customizeAjv?: AjvCustomizer;
  handlers?: HandlerMap & {
    notFound?: Handler;
    notImplemented?: Handler;
    validationFail?: Handler;
  };
  securityHandlers?: HandlerMap;
  ignoreTrailingSlashes?: boolean;
  coerceTypes?: boolean;
  /**
   * Base URI for resolving relative external `$ref`s when the definition is
   * given as an object. Ignored for path/URL definitions (their location is
   * used). The value participates in the compiled plan's cache identity.
   */
  baseUri?: string;
  /**
   * Optional plan cache. Pass the same {@link DefinitionPlanCache} instance to
   * several OpenAPIBackend instances to share compiled router/validator state
   * for identical documents and compile options. There is no global cache.
   */
  planCache?: DefinitionPlanCache;
}

/**
 * Main class and the default export of the 'openapi-backend' module
 *
 * @export
 * @class OpenAPIBackend
 */
export class OpenAPIBackend<D extends Document = Document> {
  public inputDocument: D | string;

  /** The currently active, immutable plan (route index + compiled validators). */
  private currentPlan: DefinitionPlan<D> | undefined;
  /** In-flight init promise, de-duplicated for concurrent callers. */
  private initPromise: Promise<this> | undefined;

  /**
   * Parsed document. Delegates to the active plan after successful init and is
   * kept independently for the pre-init window (loadDocument()).
   */
  public get document(): D | undefined {
    return this.currentPlan ? this.currentPlan.document : this.pendingDocument;
  }
  private pendingDocument: D | undefined;

  /** Fully dereferenced definition from the active plan. */
  public get definition(): D | undefined {
    return this.currentPlan?.definition;
  }

  public apiRoot: string;

  public initialized: boolean;

  /**
   * @deprecated Use `initialized` instead. Kept for backwards compatibility with the misspelled property name.
   */
  public get initalized(): boolean {
    return this.initialized;
  }

  public strict: boolean;
  public quick: boolean;
  public validate: boolean | ContextPredicate;
  public ignoreTrailingSlashes: boolean;

  public ajvOpts: AjvOpts;
  public customizeAjv: AjvCustomizer | undefined;
  public coerceTypes: boolean;
  public baseUri: string | undefined;

  private readonly handlerRegistry: HandlerRegistry;
  private readonly securityHandlerRegistry: HandlerRegistry;
  private readonly planCache: DefinitionPlanCache;

  /** Live, publicly readable/mutable handler map backed by the registry. */
  public get handlers(): HandlerMap {
    return this.handlerRegistry.live;
  }

  /** Live, publicly readable/mutable security-handler map backed by the registry. */
  public get securityHandlers(): HandlerMap {
    return this.securityHandlerRegistry.live;
  }

  public allowedHandlers = [
    '404',
    'notFound',
    '405',
    'methodNotAllowed',
    '501',
    'notImplemented',
    '400',
    'validationFail',
    'unauthorizedHandler',
    'preRoutingHandler',
    'postRoutingHandler',
    'postSecurityHandler',
    'preOperationHandler',
    'postResponseHandler',
  ];

  /** Route index of the active plan. */
  public get router(): OpenAPIRouter<D> {
    return this.currentPlan!.router;
  }

  /** Compiled validator of the active plan; undefined when validation disabled. */
  public get validator(): OpenAPIValidator<D> | undefined {
    return this.currentPlan?.validator;
  }

  private warnings = new Set<string>();

  /**
   * Emits a console warning once per key for the lifetime of this instance
   */
  private warnOnce(key: string, message: string): void {
    if (this.warnings.has(key)) {
      return;
    }
    this.warnings.add(key);
    console.warn(message);
  }

  /**
   * Creates an instance of OpenAPIBackend.
   *
   * @param opts - constructor options
   * @param {D | string} opts.definition - the OpenAPI definition, file path or Document object
   * @param {string} opts.apiRoot - the root URI of the api. all paths are matched relative to apiRoot
   * @param {boolean} opts.strict - strict mode, fail closed instead of warning: throw on OpenAPI spec validation
   * errors, on registering handlers for unknown operationIds, and on requests that fail security requirements or
   * request validation when no unauthorizedHandler / validationFail handler is registered (default: false)
   * @param {boolean} opts.quick - quick startup, attempts to optimise startup; might break things (default: false)
   * @param {boolean | ContextPredicate} opts.validate - whether to validate requests with Ajv, or a predicate called per
   * request to decide (default: true)
   * @param {boolean} opts.ignoreTrailingSlashes - whether to ignore trailing slashes when routing (default: true)
   * @param {boolean} opts.ajvOpts - default ajv opts to pass to the validator
   * @param {boolean} opts.coerceTypes - enable coerce typing of request path and query parameters. Coercion happens as
   * part of validation, so it only applies to requests that get validated. (default: false)
   * @param {string} opts.baseUri - base URI for resolving relative external refs of object definitions
   * @param {DefinitionPlanCache} opts.planCache - shared, instance-scoped cache of compiled plans
   * @param {{ [operationId: string]: Handler | ErrorHandler }} opts.handlers - Operation handlers to be registered
   * @memberof OpenAPIBackend
   */
  constructor(opts: Options<D>) {
    const optsWithDefaults: Options<D> = {
      apiRoot: '/',
      validate: true,
      strict: false,
      quick: false,
      ignoreTrailingSlashes: true,
      handlers: {} as HandlerMap,
      securityHandlers: {} as HandlerMap,
      coerceTypes: false,
      ...opts,
    };
    this.apiRoot = optsWithDefaults.apiRoot ?? '/';
    this.inputDocument = optsWithDefaults.definition;
    this.strict = !!optsWithDefaults.strict;
    this.quick = !!optsWithDefaults.quick;
    this.validate = optsWithDefaults.validate ?? true;
    this.ignoreTrailingSlashes = !!optsWithDefaults.ignoreTrailingSlashes;
    this.ajvOpts = optsWithDefaults.ajvOpts ?? {};
    this.customizeAjv = optsWithDefaults.customizeAjv;
    this.coerceTypes = optsWithDefaults.coerceTypes ?? false;
    this.baseUri = optsWithDefaults.baseUri;
    this.planCache = optsWithDefaults.planCache ?? new DefinitionPlanCache();

    // Copy to avoid mutating passed objects
    this.handlerRegistry = new HandlerRegistry(optsWithDefaults.handlers as HandlerMap);
    this.securityHandlerRegistry = new HandlerRegistry(optsWithDefaults.securityHandlers as HandlerMap);
  }

  /**
   * Computes the dereference strategy for the current input / quick mode.
   */
  private getDereferenceStrategy(): DereferenceStrategy {
    if (typeof this.inputDocument === 'string') {
      return 'path';
    }
    return this.quick ? 'sync-object' : 'async-object';
  }

  /**
   * Assembles the full plan-build identity (document + every compile option).
   */
  private buildPlanOptions(): PlanBuildOptions {
    return {
      inputDocument: this.inputDocument,
      apiRoot: this.apiRoot,
      ignoreTrailingSlashes: this.ignoreTrailingSlashes,
      validateDefinition: !this.quick,
      buildValidator: this.validate !== false,
      ajvOpts: this.ajvOpts,
      customizeAjv: this.customizeAjv,
      lazyCompileValidators: Boolean(this.quick),
      coerceTypes: this.coerceTypes,
      dereferenceStrategy: this.getDereferenceStrategy(),
      baseUri: this.baseUri,
    };
  }

  /**
   * Initializes OpenAPIBackend.
   *
   * 1. Loads and parses the OpenAPI document passed in constructor options
   * 2. Validates the OpenAPI document
   * 3. Dereferences the document and compiles route index + validation schemas
   *    as one atomic {@link DefinitionPlan}
   * 4. Marks property `initialized` true only after the plan is published
   *
   * Initialization is atomic: if dereferencing or any schema compilation fails,
   * the previously active plan (if any) stays in place and usable. Concurrent
   * callers share a single in-flight initialization.
   *
   * @returns parent instance of OpenAPIBackend
   * @memberof OpenAPIBackend
   */
  public async init() {
    // de-duplicate concurrent init() / auto-init calls
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInit().finally(() => {
      this.initPromise = undefined;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<this> {
    const previousPlan = this.currentPlan;
    const options = this.buildPlanOptions();

    // quick mode historically loads the parsed document eagerly (fire & forget)
    // before the plan build; keep that observable side effect.
    if (this.quick) {
      this.loadDocument();
    }

    try {
      const plan = await this.planCache.getOrBuild<D>(options);
      // publish atomically; document/definition/router/validator all flip together
      this.currentPlan = plan;
      this.pendingDocument = plan.document;
      this.initialized = true;
      return this;
    } catch (err) {
      if (this.strict) {
        // keep any previously usable plan and re-throw
        this.currentPlan = previousPlan;
        throw err;
      }
      // non-strict: warn and retain the old plan. On first init, publish an
      // empty plan so the public surface (router/validator) behaves like it
      // did historically (0 operations, validation skipped).
      console.warn(err);
      if (!previousPlan) {
        const emptyDocument = (await parsePlanDocument<D>(options).catch(() => ({
          openapi: '3.0.0',
          info: { title: '', version: '' },
          paths: {},
        }))) as D;
        this.pendingDocument = emptyDocument;
        this.currentPlan = await this.buildFallbackPlan(options, emptyDocument);
        this.initialized = true;
      } else {
        this.currentPlan = previousPlan;
      }
      return this;
    }
  }

  private async buildFallbackPlan(options: PlanBuildOptions, document: D): Promise<DefinitionPlan<D>> {
    // Build an uncached, non-validated empty plan so a failed first init still
    // exposes a router (zero operations) and, historically, a validator. The
    // empty document compiles cleanly even when the original failure happened
    // while dereferencing or compiling request schemas.
    return buildDefinitionPlan<D>(
      {
        ...options,
        inputDocument: document,
        validateDefinition: false,
        dereferenceStrategy: 'async-object',
        baseUri: undefined,
      },
      document,
    );
  }

  /**
   * Loads the input document asynchronously and sets this.document
   *
   * @memberof OpenAPIBackend
   */
  public async loadDocument() {
    this.pendingDocument = (await parseJSONSchema(this.inputDocument)) as D;
    return this.pendingDocument;
  }

  /**
   * Handles a request
   * 1. Routing: Matches the request to an API operation
   * 2. Validation: Validates the request against the API operation schema
   * 3. Handling: Passes the request on to a registered handler
   *
   * Every call gets a fresh {@link RequestContext} and a consistent generation
   * snapshot of the handler registries, so per-request state (Ajv errors,
   * security results, matched operation) never leaks between requests and a
   * handler registered mid-request is only visible to later requests.
   *
   * @param {Request} req
   * @param {...any[]} handlerArgs
   * @returns {Promise} handler return value
   * @memberof OpenAPIBackend
   */
  public async handleRequest(req: Request, ...handlerArgs: any[]): Promise<any> {
    if (!this.initialized) {
      // auto-initialize if not yet initialized (de-duplicated via init())
      await this.init();
    }

    const plan = this.currentPlan!;
    // capture consistent registry generations at the very start of the request
    const requestContext = new RequestContext<D>({
      api: this,
      plan,
      handlers: this.handlerRegistry.snapshot(),
      securityHandlers: this.securityHandlerRegistry.snapshot(),
      rawRequest: req,
      handlerArgs,
    });

    const handlers = requestContext.handlers.handlers;
    const args = requestContext.handlerArgs;

    // handle request with correct handler
    const response: any = await (async () => {
      // preRoutingHandler
      const preRoutingHandler = handlers['preRoutingHandler'];
      if (preRoutingHandler) {
        await preRoutingHandler(requestContext.toHandlerContext(), ...args);
      }

      // match operation (routing)
      try {
        requestContext.operation = plan.router.matchOperation(req, true);
      } catch (err) {
        // postRoutingHandler on routing failure
        const postRoutingHandler = handlers['postRoutingHandler'];
        if (postRoutingHandler) {
          await postRoutingHandler(requestContext.toHandlerContext(), ...args);
        }

        let handler = handlers['404'] || handlers['notFound'];
        if (err instanceof Error && err.message.startsWith('405')) {
          // 405 method not allowed
          handler = handlers['405'] || handlers['methodNotAllowed'] || handler;
        }
        if (!handler) {
          throw err;
        }
        return handler(requestContext.toHandlerContext(), ...args);
      }

      const operation = requestContext.operation;
      const operationId = operation.operationId as string;

      // parse request again now with matched operation
      requestContext.request = plan.router.parseRequest(req, operation);

      // postRoutingHandler on routing success
      const postRoutingHandler = handlers['postRoutingHandler'];
      if (postRoutingHandler) {
        await postRoutingHandler(requestContext.toHandlerContext(), ...args);
      }

      // get security requirements for the matched operation
      // global requirements are already included in the router
      const securityRequirements = operation.security || [];
      const securitySchemes = _.flatMap(securityRequirements, _.keys);

      // run registered security handlers for all security requirements
      const securityHandlerResults: SecurityHandlerResults = {};
      const securitySnapshot = requestContext.securityHandlers.handlers;
      await Promise.all(
        securitySchemes.map(async (name) => {
          securityHandlerResults[name] = undefined;
          const securityHandler = securitySnapshot[name];
          if (securityHandler) {
            // return a promise that will set the security handler result
            return await Promise.resolve()
              .then(() => securityHandler(requestContext.toHandlerContext(), ...args))
              .then((result: unknown) => {
                securityHandlerResults[name] = result;
              })
              // save rejected error as result, if thrown
              .catch((error: unknown) => {
                securityHandlerResults[name] = { error };
              });
          } else {
            // if no handler is found for scheme, set to undefined
            securityHandlerResults[name] = undefined;
          }
        }),
      );

      // auth logic
      const requirementsSatisfied = securityRequirements.map((requirementObject) => {
        /*
         * Security Requirement Objects that contain multiple schemes require
         * that all schemes MUST be satisfied for a request to be authorized.
         */
        for (const requirement of Object.keys(requirementObject)) {
          const requirementResult = securityHandlerResults[requirement];

          // falsy return values are treated as auth fail
          if (Boolean(requirementResult) === false) {
            return false;
          }

          // handle error object passed earlier
          // any object carrying a truthy `error` property is treated as a failed
          // auth, regardless of whatever other properties it carries. A falsy
          // `error` (e.g. `{ error: null, user }`) is not a rejection.
          if (
            requirementResult &&
            typeof requirementResult === 'object' &&
            (requirementResult as { error?: unknown }).error
          ) {
            return false;
          }
        }
        return true;
      });

      /*
       * When a list of Security Requirement Objects is defined on the Open API
       * object or Operation Object, only one of Security Requirement Objects
       * in the list needs to be satisfied to authorize the request.
       */
      const authorized = requirementsSatisfied.some((securityResult) => securityResult === true);

      // add the results and authorized state to the per-request context
      requestContext.security = {
        authorized,
        ...securityHandlerResults,
      };

      // postSecurityHandler
      const postSecurityHandler = handlers['postSecurityHandler'];
      if (postSecurityHandler) {
        await postSecurityHandler(requestContext.toHandlerContext(), ...args);
      }

      // call unauthorizedHandler handler if auth fails
      if (!authorized && securityRequirements.length > 0) {
        const unauthorizedHandler = handlers['unauthorizedHandler'];
        if (unauthorizedHandler) {
          return unauthorizedHandler(requestContext.toHandlerContext(), ...args);
        }
        if (this.strict) {
          // strict mode: fail closed
          throw Error(
            `401-unauthorized: ${operationId} request did not satisfy security requirements and no unauthorizedHandler is registered`,
          );
        }
        // non-strict mode: fall through to the operation handler, which is responsible for checking
        // context.security.authorized. Warn once so this doesn't go unnoticed.
        this.warnOnce(
          'unauthorizedHandler',
          `Request to ${operationId} did not satisfy its security requirements, but no unauthorizedHandler is registered. ` +
            'Proceeding to the operation handler. Register an unauthorizedHandler or set strict: true to reject these requests. ' +
            'See https://github.com/openapistack/openapi-backend/blob/main/SECURITY.md',
        );
      }

      // check whether this request should be validated
      const validate =
        typeof this.validate === 'function'
          ? this.validate(requestContext.toHandlerContext(), ...args)
          : Boolean(this.validate);

      // validate request
      const validationFailHandler = handlers['400'] || handlers['validationFail'];
      if (validate && plan.validator) {
        const validationResult = plan.validator.validateRequest(req, operation);
        requestContext.validation = validationResult;
        if (validationResult.errors) {
          // 400 request validation fail
          if (validationFailHandler) {
            return validationFailHandler(requestContext.toHandlerContext(), ...args);
          }
          if (this.strict) {
            // strict mode: fail closed
            throw Error(
              `400-validationFail: ${operationId} request failed validation and no validationFail handler is registered`,
            );
          }
          // non-strict mode: fall through to the operation handler, which is responsible for checking
          // context.validation.valid. Warn once so this doesn't go unnoticed.
          this.warnOnce(
            'validationFail',
            `Request to ${operationId} failed validation, but no validationFail handler is registered. ` +
              'Proceeding to the operation handler. Register a validationFail handler or set strict: true to reject these requests. ' +
              'See https://github.com/openapistack/openapi-backend/blob/main/SECURITY.md',
          );
        }

        // parse request again now with coerced types, if needed
        if (plan.validator.coerceTypes) {
          requestContext.request = plan.router.parseRequest(validationResult.coerced, operation);
        }
      }

      // preOperationHandler – runs just before the operation handler
      const preOperationHandler = handlers['preOperationHandler'];
      if (preOperationHandler) {
        await preOperationHandler(requestContext.toHandlerContext(), ...args);
      }

      // get operation handler
      const operationHandler = handlers[operationId];
      if (!operationHandler) {
        // 501 not implemented
        const notImplementedHandler = handlers['501'] || handlers['notImplemented'];
        if (!notImplementedHandler) {
          throw Error(`501-notImplemented: ${operationId} no handler registered`);
        }
        return notImplementedHandler(requestContext.toHandlerContext(), ...args);
      }

      // handle route
      return operationHandler(requestContext.toHandlerContext(), ...args);
    })();

    // post response handler
    const postResponseHandler = handlers['postResponseHandler'];
    if (postResponseHandler) {
      // pass response to postResponseHandler
      requestContext.response = response;
      return postResponseHandler(requestContext.toHandlerContext(), ...args);
    }

    // return response
    return response;
  }

  /**
   * Registers a handler for an operation
   *
   * @param {string} operationId
   * @param {Handler} handler
   * @memberof OpenAPIBackend
   */
  public registerHandler(operationId: string, handler: Handler): void {
    // make sure we are registering a function and not anything else
    if (typeof handler !== 'function') {
      throw new Error('Handler should be a function');
    }

    // if initialized, check that operation matches an operationId or is one of our allowed handlers
    if (this.initialized) {
      const operation = this.router.getOperation(operationId);
      if (!operation && !_.includes(this.allowedHandlers, operationId)) {
        const err = `Unknown operationId ${operationId}`;
        // in strict mode, throw Error, otherwise just emit a warning
        if (this.strict) {
          throw new Error(`${err}. Refusing to register handler`);
        } else {
          console.warn(err);
        }
      }
    }

    // register the handler (starts a new registry generation)
    this.handlerRegistry.set(operationId, handler);
  }

  /**
   * Checks an operationId is known (or an allowed special handler), warning or
   * throwing according to strict mode.
   */
  private assertRegisterableOperation(operationId: string): void {
    const operation = this.router.getOperation(operationId);
    if (!operation && !_.includes(this.allowedHandlers, operationId)) {
      const err = `Unknown operationId ${operationId}`;
      if (this.strict) {
        throw new Error(`${err}. Refusing to register handler`);
      } else {
        console.warn(err);
      }
    }
  }

  /**
   * Registers multiple handlers
   *
   * @param {{ [operationId: string]: Handler }} handlers
   * @memberof OpenAPIBackend
   */
  public register<Handlers extends HandlerMap = HandlerMap>(handlers: Handlers): void;

  /**
   * Registers a handler for an operation
   *
   * Alias for: registerHandler
   *
   * @param {string} operationId
   * @param {Handler} handler
   * @memberof OpenAPIBackend
   */
  public register<OperationHandler = Handler>(operationId: string, handler: OperationHandler): void;

  /**
   * Overloaded register() implementation
   *
   * @param {...any[]} args
   * @memberof OpenAPIBackend
   */
  public register(...args: any[]): void {
    if (typeof args[0] === 'string') {
      // register a single handler
      const operationId: string = args[0];
      const handler: Handler = args[1];
      this.registerHandler(operationId, handler);
    } else {
      const handlers: { [operationId: string]: Handler } = args[0];
      // validate every operationId first so a rejected bulk register commits
      // no partial generation
      if (this.initialized) {
        for (const operationId in handlers) {
          if (handlers[operationId]) {
            this.assertRegisterableOperation(operationId);
          }
        }
      }
      // register multiple handlers as one generation
      this.handlerRegistry.setAll(handlers);
    }
  }

  /**
   * Registers a security handler for a security scheme
   *
   * @param {string} name - security scheme name
   * @param {Handler} handler - security handler
   * @memberof OpenAPIBackend
   */
  public registerSecurityHandler(name: string, handler: Handler): void {
    // make sure we are registering a function and not anything else
    if (typeof handler !== 'function') {
      throw new Error('Security handler should be a function');
    }

    // if initialized, check that operation matches a security scheme
    if (this.initialized) {
      const securitySchemes = this.definition?.components?.securitySchemes || {};
      if (!securitySchemes[name]) {
        const err = `Unknown security scheme ${name}`;
        // in strict mode, throw Error, otherwise just emit a warning
        if (this.strict) {
          throw new Error(`${err}. Refusing to register security handler`);
        } else {
          console.warn(err);
        }
      }
    }

    // register the handler (starts a new registry generation)
    this.securityHandlerRegistry.set(name, handler);
  }

  /**
   * Mocks a response for an operation based on example or response schema
   *
   * @param {string} operationId - operationId of the operation for which to mock the response
   * @param {object} opts - (optional) options
   * @param {number} opts.responseStatus - (optional) the response code of the response to mock (default: 200)
   * @param {string} opts.mediaType - (optional) the media type of the response to mock (default: application/json)
   * @param {string} opts.example - (optional) the specific example to use (if operation has multiple examples)
   * @returns {{ status: number; mock: any }}
   * @memberof OpenAPIBackend
   */
  public mockResponseForOperation(
    operationId: string,
    opts: {
      code?: number;
      mediaType?: string;
      example?: string;
    } = {},
  ): { status: number; mock: any } {
    let status = 200;
    const defaultMock = {};

    const operation = this.router.getOperation(operationId);
    if (!operation || !operation.responses) {
      return { status, mock: defaultMock };
    }

    // resolve status code
    const { responses } = operation;
    let response: PickVersionElement<D, OpenAPIV3.ResponseObject, OpenAPIV3_1.ResponseObject>;

    if (opts.code && responses[opts.code]) {
      // 1. check for provided code opt (default: 200)
      status = Number(opts.code);
      response = responses[opts.code] as typeof response;
    } else {
      // 2. check for a default response
      const res = OpenAPIUtils.findDefaultStatusCodeMatch(responses);
      status = res.status;
      response = res.res;
    }

    if (!response || !response.content) {
      return { status, mock: defaultMock };
    }
    const { content } = response;

    // resolve media type
    // 1. check for mediaType opt in content (default: application/json)
    // 2. pick first media type in content
    const mediaType = opts.mediaType || 'application/json';
    const mediaResponse = content[mediaType] || content[Object.keys(content)[0]];
    if (!mediaResponse) {
      return { status, mock: defaultMock };
    }
    const { examples, schema } = mediaResponse;

    // if example argument was provided, locate and return its value
    if (opts.example && examples) {
      const exampleObject = examples[opts.example] as PickVersionElement<
        D,
        OpenAPIV3.ExampleObject,
        OpenAPIV3_1.ExampleObject
      >;
      if (exampleObject && exampleObject.value) {
        return { status, mock: exampleObject.value };
      }
    }

    // if operation has an example, return its value
    if (mediaResponse.example) {
      return { status, mock: mediaResponse.example };
    }

    // pick the first example from examples
    if (examples) {
      const exampleObject = examples[Object.keys(examples)[0]] as PickVersionElement<
        D,
        OpenAPIV3.ExampleObject,
        OpenAPIV3_1.ExampleObject
      >;
      return { status, mock: exampleObject.value };
    }

    // mock using json schema
    if (schema) {
      return { status, mock: mock(schema as SchemaLike) };
    }

    // we should never get here, schema or an example must be provided
    return { status, mock: defaultMock };
  }

  /**
   * Validates this.document, which is the parsed OpenAPI document. Throws an error if validation fails.
   *
   * @returns {D} parsed document
   * @memberof OpenAPIBackend
   */
  public validateDefinition(): D {
    const validateOpenAPI = new OpenAPISchemaValidator({ version: 3 });
    const { errors } = validateOpenAPI.validate(this.document);
    if (errors.length) {
      const prettyErrors = JSON.stringify(errors, null, 2);
      throw new Error(`Document is not valid OpenAPI. ${errors.length} validation errors:\n${prettyErrors}`);
    }
    return this.document as D;
  }

  /**
   * Flattens operations into a simple array of Operation objects easy to work with
   *
   * Alias for: router.getOperations()
   *
   * @returns {Operation<D>[]}
   * @memberof OpenAPIBackend
   */
  public getOperations(): Operation<D>[] {
    return this.router.getOperations();
  }

  /**
   * Gets a single operation based on operationId
   *
   * Alias for: router.getOperation(operationId)
   *
   * @param {string} operationId
   * @returns {Operation<D>}
   * @memberof OpenAPIBackend
   */
  public getOperation(operationId: string): Operation<D> | undefined {
    return this.router.getOperation(operationId);
  }

  /**
   * Matches a request to an API operation (router)
   *
   * Alias for: router.matchOperation(req)
   *
   * @param {Request} req
   * @returns {Operation<D>}
   * @memberof OpenAPIBackend
   */
  public matchOperation(req: Request): Operation<D> | undefined {
    return this.router.matchOperation(req);
  }

  /**
   * Validates a request and returns the result.
   *
   * The method will first match the request to an API operation and use the pre-compiled Ajv validation schemas to
   * validate it.
   *
   * Alias for validator.validateRequest
   *
   * @param {Request} req - request to validate
   * @param {(Operation<D> | string)} [operation]
   * @returns {ValidationStatus}
   * @memberof OpenAPIBackend
   */
  public validateRequest(req: Request, operation?: Operation<D> | string): ValidationResult {
    return this.validator!.validateRequest(req, operation);
  }

  /**
   * Validates a response and returns the result.
   *
   * The method will use the pre-compiled Ajv validation schema to validate a request it.
   *
   * Alias for validator.validateResponse
   *
   * @param {*} res - response to validate
   * @param {(Operation<D> | string)} [operation]
   * @param {number} status
   * @returns {ValidationStatus}
   * @memberof OpenAPIBackend
   */
  public validateResponse(res: any, operation: Operation<D> | string, statusCode?: number): ValidationResult {
    return this.validator!.validateResponse(res, operation, statusCode);
  }

  /**
   * Validates response headers and returns the result.
   *
   * The method will use the pre-compiled Ajv validation schema to validate a request it.
   *
   * Alias for validator.validateResponseHeaders
   *
   * @param {*} headers - response to validate
   * @param {(Operation<D> | string)} [operation]
   * @param {number} [opts.statusCode]
   * @param {SetMatchType} [opts.setMatchType] - one of 'any', 'superset', 'subset', 'exact'
   * @returns {ValidationStatus}
   * @memberof OpenAPIBackend
   */
  public validateResponseHeaders(
    headers: any,
    operation: Operation<D> | string,
    opts?: {
      statusCode?: number;
      setMatchType?: SetMatchType;
    },
  ): ValidationResult {
    return this.validator!.validateResponseHeaders(headers, operation, opts);
  }
}
