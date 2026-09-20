// library code, any is fine
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as crypto from 'crypto';
import * as path from 'path';
import * as _ from 'lodash';
import type { Options as AjvOpts } from 'ajv';
import { parse as parseJSONSchema, dereference } from './refparser';
import { dereferenceSync } from 'dereference-json-schema';
import OpenAPISchemaValidator from 'openapi-schema-validator';
import { OpenAPIRouter } from './router';
import { OpenAPIValidator, AjvCustomizer } from './validation';
import { Document } from './backend';

/**
 * How the OpenAPI document is dereferenced during plan construction.
 *
 * - `async-object`: document given as an object, dereferenced asynchronously (default)
 * - `sync-object`: document given as an object, dereferenced synchronously (quick mode)
 * - `path`: document given as a path / URL, dereferenced from its location
 */
export type DereferenceStrategy = 'async-object' | 'sync-object' | 'path';

/**
 * Options that fully determine how a {@link DefinitionPlan} is built for a document.
 *
 * Two plans are only shared when the document content and *every* option here are
 * identical (structural hash for plain data, stable identity for functions).
 */
export interface PlanBuildOptions {
  /** Raw constructor input: a parsed document object or a path / URL string. */
  inputDocument: Document | string;
  /** Root URI paths are matched relative to. */
  apiRoot: string;
  /** Ignore trailing slashes when routing. */
  ignoreTrailingSlashes: boolean;
  /** Validate the OpenAPI document itself before compiling. */
  validateDefinition: boolean;
  /** Build request/response validators when true. */
  buildValidator: boolean;
  /** Ajv constructor options, including custom formats used for validation. */
  ajvOpts: AjvOpts;
  /** Optional customizer that replaces the Ajv instances used for validation. */
  customizeAjv?: AjvCustomizer;
  /** Compile Ajv validators lazily on first use instead of up-front. */
  lazyCompileValidators: boolean;
  /** Coerce path/query parameter types during validation. */
  coerceTypes: boolean;
  /** Dereference strategy derived from the input type and quick mode. */
  dereferenceStrategy: DereferenceStrategy;
  /**
   * Base URI used to resolve relative external `$ref`s for object documents.
   * For path/URL input the input location itself is used instead.
   */
  baseUri?: string;
}

/**
 * An immutable, reusable description of everything derivable from an OpenAPI
 * document without seeing a single request.
 *
 * A plan is constructed atomically: either every component (dereferenced
 * document, router index, compiled validators) is available or construction
 * fails and no plan is published. Once built the fields are never mutated by
 * request handling or handler registration, so a plan can be shared safely
 * across concurrent requests.
 *
 * @export
 * @interface DefinitionPlan
 */
export interface DefinitionPlan<D extends Document = Document> {
  /** Fully dereferenced OpenAPI document. */
  readonly definition: D;
  /** Parsed (but not dereferenced) document. */
  readonly document: D;
  /** Route index and per-operation metadata. */
  readonly router: OpenAPIRouter<D>;
  /** Pre-compiled Ajv validators; undefined when request validation is disabled. */
  readonly validator: OpenAPIValidator<D> | undefined;
  /** Whether request validation was enabled for this plan. */
  readonly validateEnabled: boolean;
  /** Effective dereference strategy used while building. */
  readonly dereferenceStrategy: DereferenceStrategy;
}

/**
 * Stable structural hash of a JSON(-like) value.
 *
 * Object keys are sorted so key insertion order never causes a cache miss, and
 * repeated object references are encoded with stable `[ref:id]` markers so
 * recursive structures (self-referencing schemas) hash deterministically
 * instead of throwing.
 */
export function stableHash(value: unknown): string {
  const seen = new WeakMap<object, string>();
  let objectCounter = 0;

  const normalize = (val: any): string => {
    if (val === null || typeof val !== 'object') {
      if (typeof val === 'string') {
        return JSON.stringify(val);
      }
      if (typeof val === 'number' || typeof val === 'boolean' || val === null) {
        return `${typeof val}:${String(val)}`;
      }
      if (typeof val === 'undefined') {
        return 'undefined';
      }
      // functions/symbols are not meaningful inside document JSON
      return `[${typeof val}]`;
    }
    const existing = seen.get(val);
    if (existing !== undefined) {
      return `[ref:${existing}]`;
    }
    const id = `o${objectCounter++}`;
    seen.set(val, id);
    if (Array.isArray(val)) {
      return `[${id}:${val.map(normalize).join(',')}]`;
    }
    const entries = Object.keys(val)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${normalize(val[key])}`);
    return `{${id}:${entries.join(',')}}`;
  };

  return crypto.createHash('sha256').update(normalize(value)).digest('hex');
}

/**
 * Assigns a stable identity to function values (e.g. customizeAjv callbacks)
 * so functions participate in cache keys without being serialised.
 */
class FunctionIdentity {
  private readonly ids = new WeakMap<object, number>();
  private counter = 0;

  public id(fn: AjvCustomizer | undefined): string {
    if (!fn) {
      return 'none';
    }
    let id = this.ids.get(fn);
    if (id === undefined) {
      id = this.counter++;
      this.ids.set(fn, id);
    }
    return `fn:${id}`;
  }
}

export interface PlanCacheKeyParts {
  documentHash: string;
  documentSource: string;
  apiRoot: string;
  ignoreTrailingSlashes: boolean;
  validateDefinition: boolean;
  buildValidator: boolean;
  ajvOptsHash: string;
  customizeAjvId: string;
  lazyCompileValidators: boolean;
  coerceTypes: boolean;
  dereferenceStrategy: DereferenceStrategy;
  baseUri: string;
}

/**
 * Computes the full cache identity of a build request.
 *
 * Mutable objects are never used as identity on their own: document content and
 * Ajv options contribute structural hashes, while function values (custom Ajv)
 * contribute stable per-function ids.
 */
export function computePlanCacheKey(
  options: PlanBuildOptions,
  rawDocumentSnapshot: Document | string | undefined,
  functionIdentity: FunctionIdentity,
): string {
  // Identity is taken from the RAW input before parsing/dereferencing:
  // dereference() resolves $ref properties in place, so hashing a document
  // that has already been dereferenced would pollute later lookup keys.
  const identitySource = rawDocumentSnapshot ?? options.inputDocument;
  const documentHash = stableHash(identitySource);

  // path/URL input additionally identifies by its resolved location
  const documentSource = typeof options.inputDocument === 'string' ? path.resolve(options.inputDocument) : 'object';

  const parts: PlanCacheKeyParts = {
    documentHash,
    documentSource,
    apiRoot: options.apiRoot,
    ignoreTrailingSlashes: options.ignoreTrailingSlashes,
    validateDefinition: options.validateDefinition,
    buildValidator: options.buildValidator,
    ajvOptsHash: stableHash(options.ajvOpts || {}),
    customizeAjvId: functionIdentity.id(options.customizeAjv),
    lazyCompileValidators: options.lazyCompileValidators,
    coerceTypes: options.coerceTypes,
    dereferenceStrategy: options.dereferenceStrategy,
    baseUri: options.baseUri ?? '',
  };
  return stableHash(parts);
}

/**
 * Parses the plan input into a plain document.
 */
export async function parsePlanDocument<D extends Document>(options: PlanBuildOptions): Promise<D> {
  const { inputDocument } = options;
  return (typeof inputDocument === 'string' ? await parseJSONSchema(inputDocument) : inputDocument) as D;
}

/**
 * Builds a {@link DefinitionPlan} atomically.
 *
 * The whole pipeline (parse -> validate -> dereference -> route index ->
 * validator compilation) completes before the returned promise resolves with a
 * frozen plan. Any failure rejects the promise and leaves plans already held by
 * callers or caches untouched.
 */
export async function buildDefinitionPlan<D extends Document = Document>(
  options: PlanBuildOptions,
  preParsedDocument?: D,
): Promise<DefinitionPlan<D>> {
  const { inputDocument } = options;

  // 1. parse the document (string input only; objects are used directly)
  const parsed = (preParsedDocument ??
    (typeof inputDocument === 'string' ? await parseJSONSchema(inputDocument) : inputDocument)) as D;
  // Clone object documents before dereferencing:
  // @apidevtools/json-schema-ref-parser resolves $ref properties in place,
  // which would otherwise mutate the caller's input object and, via the cached
  // plan, leak state across shared requests. Path/URL input is dereferenced
  // straight from its location (external refs need the file base), so the
  // freshly parsed document is used unchanged there.
  const document = (options.dereferenceStrategy === 'path' ? parsed : _.cloneDeep(parsed)) as D;

  // 2. validate the parsed OpenAPI document
  if (options.validateDefinition) {
    const validateOpenAPI = new OpenAPISchemaValidator({ version: 3 });
    const { errors } = validateOpenAPI.validate(document);
    if (errors.length) {
      const prettyErrors = JSON.stringify(errors, null, 2);
      throw new Error(`Document is not valid OpenAPI. ${errors.length} validation errors:\n${prettyErrors}`);
    }
  }

  // 3. dereference (makes sure not to copy the document)
  let definition: D;
  if (options.dereferenceStrategy === 'path') {
    definition = (await dereference(inputDocument as string)) as D;
  } else if (options.dereferenceStrategy === 'sync-object') {
    definition = dereferenceSync(document) as D;
  } else if (options.baseUri !== undefined) {
    // Dereference relative to the provided base URI. The base is used as the
    // resolution root for external $refs; if it cannot be opened directly
    // (e.g. a logical URI), fall back to dereferencing the document while
    // keeping the baseUri as part of the cache identity.
    try {
      definition = (await dereference(options.baseUri, document as any)) as D;
    } catch {
      definition = (await dereference(document)) as D;
    }
  } else {
    definition = (await dereference(document)) as D;
  }

  // 4. build the immutable route index
  const router = new OpenAPIRouter<D>({
    definition,
    apiRoot: options.apiRoot,
    ignoreTrailingSlashes: options.ignoreTrailingSlashes,
  });

  // 5. compile Ajv validators (throws here -> no plan gets published)
  let validator: OpenAPIValidator<D> | undefined;
  if (options.buildValidator) {
    validator = new OpenAPIValidator<D>({
      definition,
      ajvOpts: options.ajvOpts,
      customizeAjv: options.customizeAjv,
      router,
      lazyCompileValidators: options.lazyCompileValidators,
      coerceTypes: options.coerceTypes,
    });
  }

  const plan: DefinitionPlan<D> = {
    definition,
    document,
    router,
    validator,
    validateEnabled: options.buildValidator,
    dereferenceStrategy: options.dereferenceStrategy,
  };

  // Freeze the plan surface. The dereferenced document itself is not deep
  // frozen (external consumers still read/mock it), but plan fields are never
  // reassigned outside this builder.
  return Object.freeze(plan);
}

/**
 * Instance-scoped cache of compiled {@link DefinitionPlan}s.
 *
 * The cache is opt-in per OpenAPIBackend instance and there is intentionally no
 * module-level singleton: pass the same cache instance to multiple backends to
 * safely share a compiled definition. Concurrent builds with the same identity
 * are de-duplicated, and failed builds are evicted so they can be retried while
 * plans already in use remain available.
 *
 * @export
 * @class DefinitionPlanCache
 */
export class DefinitionPlanCache {
  private readonly plans = new Map<string, DefinitionPlan>();
  private readonly pending = new Map<string, Promise<DefinitionPlan>>();
  private readonly functionIdentity = new FunctionIdentity();

  /**
   * Returns a cached plan or builds (and caches) a new one.
   */
  public async getOrBuild<D extends Document = Document>(options: PlanBuildOptions): Promise<DefinitionPlan<D>> {
    // Snapshot the raw input for identity before any dereference side effects
    // (object $ref properties are resolved in place during the build).
    const rawSnapshot: Document | string =
      typeof options.inputDocument === 'string' ? options.inputDocument : _.cloneDeep(options.inputDocument);
    const key = computePlanCacheKey(options, rawSnapshot, this.functionIdentity);

    const cached = this.plans.get(key);
    if (cached) {
      return cached as DefinitionPlan<D>;
    }

    const inflight = this.pending.get(key);
    if (inflight) {
      return inflight as Promise<DefinitionPlan<D>>;
    }

    // Parse the raw input once, then build atomically. Parsing is side-effect
    // free and the parsed object is also what gets validated/dereferenced.
    const build = parsePlanDocument<D>(options)
      .then((parsedDocument) => buildDefinitionPlan<D>(options, parsedDocument))
      .then(
        (plan) => {
          this.plans.set(key, plan);
          this.pending.delete(key);
          return plan;
        },
        (err) => {
          // never cache failures; drop the in-flight slot so callers can retry
          this.pending.delete(key);
          throw err;
        },
      );
    this.pending.set(key, build);
    return build;
  }

  /** Number of successfully built plans currently cached. */
  public get size(): number {
    return this.plans.size;
  }

  /** Removes all cached plans. */
  public clear(): void {
    this.plans.clear();
  }
}
