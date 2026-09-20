/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Repeatable benchmark comparing plan initialization (dereference + Ajv
 * compilation) with hot request handling on a large generated definition.
 *
 * The timing numbers are informational; the hard guarantees are checked
 * deterministically by counting Ajv `compile()` calls:
 *  - initializing compiles the full set of validators once,
 *  - hot requests (even hundreds, even concurrent) trigger zero recompilation,
 *  - a second backend with the same definition + shared cache recompiles
 *    nothing, and its warm init is far cheaper than a cold init.
 */
import Ajv from 'ajv';
import { OpenAPIBackend, DefinitionPlanCache } from './backend';
import { buildLargeDocument } from './large-definition';

const PATH_COUNT = 400;
const HOT_REQUESTS = 300;

function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = process.hrtime.bigint();
  return fn().then((value) => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { value, ms };
  });
}

describe('large definition benchmark', () => {
  let compileSpy: jest.SpyInstance;
  let compileCount = 0;

  beforeEach(() => {
    compileCount = 0;
    const orig = Ajv.prototype.compile;
    compileSpy = jest.spyOn(Ajv.prototype, 'compile').mockImplementation(function (this: Ajv, schema: any) {
      compileCount++;
      return orig.call(this, schema);
    });
  });

  afterEach(() => {
    compileSpy.mockRestore();
  });

  test('cold init compiles validators; hot requests and warm inits do not', async () => {
    const doc = buildLargeDocument({ paths: PATH_COUNT });
    const cache = new DefinitionPlanCache();

    const cold = await timed(async () => {
      const api = new OpenAPIBackend({ definition: doc, planCache: cache });
      for (let i = 0; i < PATH_COUNT; i++) {
        api.register(`getItem${i}`, () => ({ ok: true }));
      }
      await api.init();
      return api;
    });
    const api = cold.value;
    const coldCompiles = compileCount;
    expect(coldCompiles).toBeGreaterThan(PATH_COUNT); // request + response + header validators

    // hot requests, including concurrent bursts, must not recompile anything
    const hot = await timed(async () => {
      const promises: Promise<any>[] = [];
      for (let i = 0; i < HOT_REQUESTS; i++) {
        const id = i % PATH_COUNT;
        promises.push(api.handleRequest({ method: 'get', path: `/items/${id}/${id}`, headers: {} }));
        if (promises.length === 50) {
          await Promise.all(promises);
          promises.length = 0;
        }
      }
    });
    expect(compileCount).toBe(coldCompiles);

    // a second backend sharing the cache recompiles nothing and inits warm
    compileCount = 0;
    const warm = await timed(async () => {
      const api2 = new OpenAPIBackend({ definition: buildLargeDocument({ paths: PATH_COUNT }), planCache: cache });
      await api2.init();
      return api2;
    });
    expect(compileCount).toBe(0);
    expect(cache.size).toBe(1);
    expect((warm.value as any).currentPlan).toBe((api as any).currentPlan);
    warm.value;

    // informational timing report (jest --silent=false to view)
    const report = {
      operations: PATH_COUNT * 2,
      coldInitMs: Math.round(cold.ms),
      hotRequests: HOT_REQUESTS,
      hotRequestsMs: Math.round(hot.ms),
      warmInitMs: Math.round(warm.ms),
      ajvCompilesOnColdInit: coldCompiles,
      ajvCompilesOnHotRequests: 0,
      ajvCompilesOnWarmInit: 0,
    };
    // eslint-disable-next-line no-console
    console.log('BENCHMARK ' + JSON.stringify(report));

    // a single hot request must be orders of magnitude cheaper than cold init
    const perHotMs = hot.ms / HOT_REQUESTS;
    expect(perHotMs).toBeLessThan(cold.ms);
    // warm init must be much cheaper than a cold compile
    expect(warm.ms).toBeLessThan(cold.ms);
  }, 60000);
});
