// library code, any is fine
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Document } from './backend';

export interface LargeDefinitionOptions {
  /** Number of paths/operations to generate. */
  paths?: number;
  /** Number of schema properties per operation. */
  properties?: number;
}

/**
 * Builds a deterministic, repeatable large OpenAPI document used to benchmark
 * plan initialization (dereference + Ajv compilation) against hot request
 * handling. Every path has unique path/query parameters and a JSON request
 * body so that each operation triggers real Ajv validator compilation.
 */
export function buildLargeDocument(opts: LargeDefinitionOptions = {}): Document {
  const pathCount = opts.paths ?? 500;
  const propertyCount = opts.properties ?? 12;

  const schemaProperties: Record<string, any> = {};
  const required: string[] = [];
  for (let i = 0; i < propertyCount; i++) {
    schemaProperties[`field${i}`] =
      i % 3 === 0
        ? { type: 'integer', minimum: 0, maximum: 1_000_000 }
        : i % 3 === 1
        ? { type: 'string', minLength: 1, maxLength: 64 }
        : { type: 'boolean' };
    if (i % 4 === 0) {
      required.push(`field${i}`);
    }
  }

  const paths: Record<string, any> = {};
  for (let i = 0; i < pathCount; i++) {
    paths[`/items/${i}/{id}`] = {
      get: {
        operationId: `getItem${i}`,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          {
            name: 'expand',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['none', 'full'] },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
      post: {
        operationId: `createItem${i}`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: schemaProperties,
                required,
              },
            },
          },
        },
        responses: { '201': { description: 'created' } },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: { title: 'large-benchmark-api', version: '1.0.0' },
    paths,
  } as Document;
}
