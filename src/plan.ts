// library code, any is fine
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as _ from 'lodash';
import type { Options as AjvOpts } from 'ajv';
import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';

import { dereference } from './refparser';
import { dereferenceSync } from 'dereference-json-schema';

import { OpenAPIRouter, Operation } from './router';
import { OpenAPIValidator, AjvCustomizer } from './validation';

// alias Document to OpenAPIV3_1.Document
type Document = OpenAPIV3_1.Document | OpenAPIV3.Document;

/**
 * WeakMap assigning a stable identity number to functions (e.g. customizeAjv or functions inside ajvOpts).
 *
 * Function identity is part of the plan identity: the same function reference always maps to the same id,
 * different references never share an id. Functions are immutable for the purposes of identity, so this is
 * safe - unlike mutable document objects, which are hashed by content instead of by reference.
 */
const functionIds = new WeakMap<(...args: any[]) => any, number>();
let nextFunctionId = 0;

function getFunctionId(fn: (...args: any[]) => any): number {
  let id = functionIds.get(fn);
  if (id === undefined) {
    id = ++nextFunctionId;
    functionIds.set(fn, id);
  }
  return id;
}

/**
 * Serializes a value deterministically: object keys are sorted, functions are represented by their stable
 * identity id and circular structures are marked instead of recursing forever.
 *
 * Used to compute content-based cache identities for OpenAPI documents and compile options, so that a
 * mutable object reference is never used as an incomplete cache key.
 *
 * @param {*} value
 * @returns {string}
 */
export function stableStringify(value: any): string {
  const seen = new Set<object>();
  const serialize = (val: any): string => {
    if (val === null) {
      return 'null';
    }
    switch (typeof val) {
      case 'undefined':
        return 'undefined';
      case 'number':
      case 'boolean':
      case 'string':
        return JSON.stringify(val);
      case 'function':
        return `"[function#${getFunctionId(val)}]"`;
      case 'object': {
        if (seen.has(val)) {
          return '"[circular]"';
        }
        seen.add(val);
        try {
          if (Array.isArray(val)) {
            return `[${val.map(serialize).join(',')}]`;
          }
          const keys = Object.keys(val).sort();
          return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(val[key])}`).join(',')}}`;
        } finally {
          seen.delete(val);
        }
      }
      default:
        return JSON.stringify(String(val));
    }
  };
  return serialize(value);
}

/**
 * Hashes a string with 64-bit FNV-1a. Pure JS so the library stays environment-agnostic.
 *
 * @param {string} input
 * @returns {string} hex digest
 */
export function hashString(input: string): string {
  // 64-bit FNV-1a, computed as two 32-bit halves to stay within JS number precision
  let hi = 0x811c9dc5;
  let lo = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    lo = Math.imul(lo ^ (code & 0xff), 0x01000193);
    hi = Math.imul(hi ^ (code >> 8), 0x01000193);
  }
  return `${(hi >>> 0).toString(16)}${(lo >>> 0).toString(16)}`;
}

/**
 * Computes the cache identity component for the input document.
 *
 * For string definitions (file path or URL) the string itself is the identity: it doubles as the document
 * base URI used when dereferencing. For object definitions the full content is serialized and hashed, so
 * two structurally identical documents share an identity and a mutated document gets a fresh one.
 *
 * @param {Document | string} definition - input document or file path / URL
 * @returns {string}
 */
export function computeDocumentKey(definition: Document | string): string {
  if (typeof definition === 'string') {
    return `uri:${definition}`;
  }
  return `doc:${hashString(stableStringify(definition))}`;
}

/**
 * Inputs that determine the identity of a compiled DefinitionPlan.
 *
 * Everything that can change the compiled output must be part of the identity: the document content (or
 * its base URI for string inputs), routing options, the dereference strategy (quick mode), whether a
 * validator is built, and every option that can change format validation (ajvOpts, customizeAjv,
 * coerceTypes).
 *
 * @export
 * @interface PlanIdentityComponents
 */
export interface PlanIdentityComponents {
  documentKey: string;
  apiRoot: string;
  ignoreTrailingSlashes: boolean;
  validate: boolean;
  ajvOpts: AjvOpts;
  customizeAjv?: AjvCustomizer;
  coerceTypes: boolean;
  quick: boolean;
}

/**
 * Computes a content-based identity string for a DefinitionPlan. Identical definitions with identical
 * compile options produce identical identities; any difference in the inputs above produces a different
 * identity, so plans compiled with different options are never shared.
 *
 * @param {PlanIdentityComponents} components
 * @returns {string}
 */
export function computePlanIdentity(components: PlanIdentityComponents): string {
  const optionsKey = stableStringify({
    apiRoot: components.apiRoot,
    ignoreTrailingSlashes: components.ignoreTrailingSlashes,
    validate: components.validate,
    ajvOpts: components.ajvOpts,
    customizeAjv: components.customizeAjv ?? null,
    coerceTypes: components.coerceTypes,
    quick: components.quick,
  });
  return `plan:${components.documentKey}:${hashString(optionsKey)}`;
}

/**
 * Options for building a DefinitionPlan
 *
 * @export
 * @interface DefinitionPlanBuildOptions
 */
export interface DefinitionPlanBuildOptions<D extends Document = Document> {
  inputDocument: D | string;
  document?: D;
  apiRoot?: string;
  ignoreTrailingSlashes?: boolean;
  validate?: boolean;
  ajvOpts?: AjvOpts;
  customizeAjv?: AjvCustomizer;
  coerceTypes?: boolean;
  quick?: boolean;
  identity?: string;
}

/**
 * An immutable, fully compiled plan derived deterministically from an OpenAPI document.
 *
 * A DefinitionPlan contains everything that can be determined from the document alone:
 * - the dereferenced definition
 * - the router with its route index (operations and operationsById)
 * - operation metadata, including the serialized parameter rules carried on each operation
 * - the validator with its pre-compiled Ajv validator functions
 *
 * Once built, a plan must never be mutated by request handling or by handlers; requests and handler
 * registries keep their state in a short-lived RequestContext instead. Plans are safe to share across
 * OpenAPIBackend instances via a DefinitionPlanCache.
 *
 * Building is atomic: DefinitionPlan.build() either resolves with a complete plan or rejects, it never
 * yields a partially initialized plan.
 *
 * @export
 * @class DefinitionPlan
 */
export class DefinitionPlan<D extends Document = Document> {
  /**
   * Content-based identity of this plan, see computePlanIdentity
   */
  public readonly identity: string;

  /**
   * The dereferenced OpenAPI definition
   */
  public readonly definition: D;

  /**
   * Router holding the route index for the definition
   */
  public readonly router: OpenAPIRouter<D>;

  /**
   * Validator with pre-compiled Ajv validator functions. Undefined when validation is disabled.
   */
  public readonly validator?: OpenAPIValidator<D>;

  /**
   * Flat index of all operations in the definition
   */
  public readonly operations: ReadonlyArray<Operation<D>>;

  /**
   * Index of operations by operationId
   */
  public readonly operationsById: ReadonlyMap<string, Operation<D>>;

  private constructor(opts: {
    identity: string;
    definition: D;
    router: OpenAPIRouter<D>;
    validator?: OpenAPIValidator<D>;
    operations: Operation<D>[];
    operationsById: Map<string, Operation<D>>;
  }) {
    this.identity = opts.identity;
    this.definition = opts.definition;
    this.router = opts.router;
    this.validator = opts.validator;
    this.operations = Object.freeze(opts.operations.slice());
    this.operationsById = new Map(opts.operationsById);
    Object.freeze(this);
  }

  /**
   * Builds a DefinitionPlan from an OpenAPI document.
   *
   * Dereferences the document, builds the route index and pre-compiles all Ajv validators. Any failure
   * (dereference errors, schema compilation errors) rejects the promise; no partial plan is observable.
   *
   * @param {DefinitionPlanBuildOptions<D>} opts
   * @returns {Promise<DefinitionPlan<D>>}
   */
  public static async build<D extends Document = Document>(
    opts: DefinitionPlanBuildOptions<D>,
  ): Promise<DefinitionPlan<D>> {
    const definition = await DefinitionPlan.dereferenceDocument<D>(opts);
    return DefinitionPlan.fromDefinition<D>(definition, opts);
  }

  /**
   * Builds a DefinitionPlan from an already dereferenced definition.
   *
   * @param {D} definition
   * @param {DefinitionPlanBuildOptions<D>} opts
   * @returns {DefinitionPlan<D>}
   */
  public static fromDefinition<D extends Document = Document>(
    definition: D,
    opts: DefinitionPlanBuildOptions<D> = { inputDocument: definition },
  ): DefinitionPlan<D> {
    const router = new OpenAPIRouter<D>({
      definition,
      apiRoot: opts.apiRoot,
      ignoreTrailingSlashes: opts.ignoreTrailingSlashes,
    });

    let validator: OpenAPIValidator<D> | undefined;
    if (opts.validate !== false) {
      validator = new OpenAPIValidator<D>({
        definition,
        ajvOpts: opts.ajvOpts,
        customizeAjv: opts.customizeAjv,
        router,
        lazyCompileValidators: Boolean(opts.quick), // optimise startup by lazily compiling Ajv validators
        coerceTypes: opts.coerceTypes,
      });
    }

    const operations = router.getOperations();
    const operationsById = new Map<string, Operation<D>>();
    for (const operation of operations) {
      if (operation.operationId) {
        operationsById.set(operation.operationId, operation);
      }
    }

    return new DefinitionPlan<D>({
      identity: opts.identity ?? '',
      definition,
      router,
      validator,
      operations,
      operationsById,
    });
  }

  /**
   * Dereferences the input document according to the dereference strategy (quick mode uses the
   * synchronous dereferencer for object inputs)
   *
   * Object inputs are deep-cloned first: the async dereferencer mutates its input in place, and the
   * plan must never alias the caller's mutable document - otherwise later mutations of the input
   * would silently corrupt the built plan.
   *
   * @param {DefinitionPlanBuildOptions<D>} opts
   * @returns {Promise<D>}
   */
  private static async dereferenceDocument<D extends Document = Document>(
    opts: DefinitionPlanBuildOptions<D>,
  ): Promise<D> {
    if (typeof opts.inputDocument === 'string') {
      return (await dereference(opts.inputDocument)) as D;
    }
    const input = _.cloneDeep(opts.document || opts.inputDocument);
    if (opts.quick && typeof opts.inputDocument === 'object') {
      // use sync dereference in quick mode
      return dereferenceSync(input) as D;
    }
    return (await dereference(input)) as D;
  }
}

/**
 * An explicit cache for compiled DefinitionPlans, keyed by plan identity.
 *
 * The cache is never a global singleton: create an instance and pass it to OpenAPIBackend via
 * `opts.planCache` to share compiled plans between instances. Each OpenAPIBackend keeps its own private
 * cache when none is provided.
 *
 * @export
 * @class DefinitionPlanCache
 */
export class DefinitionPlanCache {
  private plans = new Map<string, DefinitionPlan<any>>();

  /**
   * Returns the cached plan for an identity, or undefined
   *
   * @param {string} identity
   * @returns {DefinitionPlan | undefined}
   */
  public get<D extends Document = Document>(identity: string): DefinitionPlan<D> | undefined {
    return this.plans.get(identity);
  }

  /**
   * Stores a plan under its identity
   *
   * @param {DefinitionPlan} plan
   */
  public set<D extends Document = Document>(plan: DefinitionPlan<D>): void {
    if (plan.identity) {
      this.plans.set(plan.identity, plan);
    }
  }

  /**
   * Deletes the plan for an identity
   *
   * @param {string} identity
   * @returns {boolean} whether a plan was deleted
   */
  public delete(identity: string): boolean {
    return this.plans.delete(identity);
  }

  /**
   * Removes all cached plans
   */
  public clear(): void {
    this.plans.clear();
  }

  /**
   * Number of cached plans
   */
  public get size(): number {
    return this.plans.size;
  }
}
