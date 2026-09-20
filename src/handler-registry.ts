// library code, any is fine
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Handler, HandlerMap } from './backend';

/**
 * An immutable, point-in-time view of the registered handlers.
 *
 * A snapshot is taken at the very beginning of each request and held for its
 * whole duration, so handlers registered while the request is in flight can
 * never make a single request observe two registry generations.
 *
 * @export
 * @interface HandlerSnapshot
 */
export interface HandlerSnapshot {
  /** Monotonically increasing generation number; bumped on every mutation. */
  readonly generation: number;
  /** Frozen map of operationId (or special handler name) -> handler. */
  readonly handlers: Readonly<HandlerMap>;
}

/**
 * Stores operation / lifecycle handlers and provides consistent generation
 * snapshots for request processing.
 *
 * The registry is mutable (handlers can be registered at any time) but
 * snapshots are immutable: the backing map is replaced on every mutation
 * instead of being mutated in place, so a snapshot captured earlier keeps its
 * version. Mutations made directly through the public live view
 * (`api.handlers[id] = fn` / `delete api.handlers[id]`) are funnelled through
 * the same atomic update path.
 *
 * @export
 * @class HandlerRegistry
 */
export class HandlerRegistry {
  private map: HandlerMap;
  private generation = 0;
  private readonly liveView: HandlerMap;

  constructor(initial?: HandlerMap) {
    this.map = { ...(initial || {}) };

    // Public view: reads see the current generation, writes are atomic and
    // bump the generation so in-flight requests keep their snapshot.
    this.liveView = new Proxy(this.map, {
      get: (_target, prop) => this.map[prop as string],
      set: (_target, prop, value) => {
        this.set(prop as string, value as Handler);
        return true;
      },
      deleteProperty: (_target, prop) => {
        this.delete(prop as string);
        return true;
      },
      has: (_target, prop) => prop in this.map,
      ownKeys: () => Reflect.ownKeys(this.map),
      getOwnPropertyDescriptor: (_target, prop) => Object.getOwnPropertyDescriptor(this.map, prop as string),
    });
  }

  /** Sets or replaces a handler and starts a new generation. */
  public set(operationId: string, handler: Handler): void {
    this.map = { ...this.map, [operationId]: handler };
    this.generation++;
  }

  /** Removes a handler and starts a new generation. */
  public delete(operationId: string): void {
    if (!(operationId in this.map)) {
      return;
    }
    const next = { ...this.map };
    delete next[operationId];
    this.map = next;
    this.generation++;
  }

  /** Sets many handlers and starts a single new generation. */
  public setAll(handlers: HandlerMap): void {
    const next: HandlerMap = { ...this.map };
    let changed = false;
    for (const operationId in handlers) {
      const handler = handlers[operationId];
      if (handler) {
        next[operationId] = handler;
        changed = true;
      }
    }
    if (changed) {
      this.map = next;
      this.generation++;
    }
  }

  /** Current handler value (registration-time lookups). */
  public get(operationId: string): Handler | undefined {
    return this.map[operationId];
  }

  /**
   * Captures the current generation. The returned object (and its handler map)
   * is frozen and safe to hold across asynchronous work.
   */
  public snapshot(): HandlerSnapshot {
    return Object.freeze({
      generation: this.generation,
      handlers: Object.freeze({ ...this.map }),
    });
  }

  /** Live view exposed as the public `api.handlers` / `api.securityHandlers` map. */
  public get live(): HandlerMap {
    return this.liveView;
  }
}
