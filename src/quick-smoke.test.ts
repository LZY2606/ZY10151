import * as path from 'path';
import { OpenAPIBackend } from './backend';

const circularRefPath = path.join(__dirname, '..', '__tests__', 'resources', 'refs.openapi.json');

test('quick mode lazily compiles validators and handles sync deref', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const doc = require(circularRefPath);
  const api = new OpenAPIBackend({ definition: doc, quick: true });
  await api.init();
  expect(api.initialized).toBe(true);
  expect(
    api
      .getOperations()
      .map((o) => o.operationId)
      .sort(),
  ).toEqual(['createTree', 'getTrees']);
  api.register('createTree', () => 'created');
  const res = await api.handleRequest({
    method: 'post',
    path: '/trees',
    headers: { 'content-type': 'application/json' },
    body: { value: 1 },
  });
  expect(res).toBe('created');
});

test('quick mode with a file path still dereferences', async () => {
  const api = new OpenAPIBackend({ definition: circularRefPath, quick: true });
  await api.init();
  expect(api.getOperations()).toHaveLength(2);
});
