import { describe, expect, it } from 'vitest';
import { createOperationCatalog } from '../src/modules/integrations/catalog';

const route = (method: string, path: string) => ({ method, url: `/api/v1${path}` });

describe('external operation catalog', () => {
  it('only exposes explicitly classified routes and reports unknown additions', () => {
    const catalog = createOperationCatalog();
    catalog.registerRoute(route('GET', '/projects/:projectId/todos'));
    catalog.registerRoute(route('POST', '/projects/:projectId/todos'));
    catalog.registerRoute(route('POST', '/projects/:projectId/todos/unreviewed'));
    expect(catalog.get('GET /projects/:projectId/todos')?.access).toBe('open');
    expect(catalog.get('POST /projects/:projectId/todos')?.effect).toBe('write');
    expect(catalog.get('POST /projects/:projectId/todos/unreviewed')?.access).toBe('unclassified');
    expect(catalog.coverage().unclassified).toEqual(['POST /projects/:projectId/todos/unreviewed']);
  });

  it('keeps sensitive routes interactive while retaining semantic read operations', () => {
    const catalog = createOperationCatalog();
    const paths = [
      ['DELETE', '/projects/:projectId'],
      ['PATCH', '/projects/:projectId/members/:userId'],
      ['POST', '/projects/:projectId/providers'],
      ['POST', '/projects/:projectId/reviews/:reviewId/verdict'],
      ['POST', '/projects/:projectId/research/records/:recordId/runs/:runId/steps/:stepId/confirm'],
      ['POST', '/projects/:projectId/notebooks/:notebookId/inspect'],
    ];
    for (const [method, path] of paths) catalog.registerRoute(route(method!, path!));
    for (const [method, path] of paths.slice(0, -1)) {
      expect(catalog.getByRoute(method!, `/api/v1${path}`)?.access).toBe('interactive');
    }
    expect(catalog.get('POST /projects/:projectId/notebooks/:notebookId/inspect')?.effect).toBe(
      'read',
    );
  });

  it('exposes concrete input contracts for shared and route-local schemas', () => {
    const catalog = createOperationCatalog();
    catalog.registerRoute(route('POST', '/projects/:projectId/todos'));
    catalog.registerRoute(route('POST', '/projects/:projectId/notebooks/:notebookId/inspect'));
    const todo = catalog.get('POST /projects/:projectId/todos');
    const inspect = catalog.get('POST /projects/:projectId/notebooks/:notebookId/inspect');
    expect(todo?.input.query).toMatchObject({ type: 'object', properties: {} });
    expect(todo?.input.body).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string' } },
    });
    expect(inspect?.input.body).toMatchObject({ required: ['code', 'cursorPos'] });
    expect(inspect?.input.params).toEqual(['projectId', 'notebookId']);
  });

  it('describes notebook continuation and wildcard memory paths', () => {
    const catalog = createOperationCatalog();
    catalog.registerRoute(route('GET', '/projects/:projectId/notebooks/:notebookId/contents'));
    catalog.registerRoute(route('GET', '/projects/:projectId/memory/*'));
    const notebook = catalog.get('GET /projects/:projectId/notebooks/:notebookId/contents');
    expect(notebook?.access).toBe('open');
    expect(notebook?.input.query).toMatchObject({
      properties: { contentHash: { type: 'string' } },
    });
    expect(notebook?.response).toMatchObject({
      properties: { nextOffset: { type: ['integer', 'null'] } },
    });
    expect(catalog.get('GET /projects/:projectId/memory/*')?.input.params).toEqual([
      'projectId',
      '*',
    ]);
  });
});

describe('registered API operation coverage', () => {
  it('classifies and describes every registered open operation', async () => {
    const { makeApp } = await import('./helpers');
    const { operationCatalog } = await import('../src/app');
    const app = await makeApp();
    try {
      const coverage = operationCatalog(app.app.ctx).coverage();
      expect(coverage.unclassified).toEqual([]);
      expect(coverage.missingInput).toEqual([]);
      expect(coverage.missingResponse).toEqual([]);
    } finally {
      await app.close();
    }
  }, 60_000);
});
