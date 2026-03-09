import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const { mockQuery, mockQueryOne, activeUser } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockQueryOne: vi.fn(),
  activeUser: { current: null as any },
}));

vi.mock('@leasebase/service-common', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@leasebase/service-common')>();
  return {
    ...mod,
    query: mockQuery,
    queryOne: mockQueryOne,
    requireAuth: (req: any, _res: any, next: any) => {
      if (!activeUser.current) return next(new mod.UnauthorizedError());
      req.user = { ...activeUser.current };
      next();
    },
  };
});

import express from 'express';
import { pmRoutesRouter } from '../routes/pm-routes';

function req(
  port: number,
  method: string,
  path: string,
  body?: any,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const r = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const user = (overrides: Record<string, any> = {}) => ({
  sub: 'u1', userId: 'u1', orgId: 'org-1', email: 'pm@test.com',
  role: 'PM_STAFF', name: 'PM User', scopes: ['api/read', 'api/write'],
  ...overrides,
});

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/pm', pmRoutesRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
});
afterAll(() => server?.close());
beforeEach(() => { mockQuery.mockReset(); mockQueryOne.mockReset(); });

/* ═══════════════════════════════════════════════════════════════════
   Role Guards — OWNER/TENANT → 403
   ═══════════════════════════════════════════════════════════════════ */

describe('Role guards', () => {
  const endpoints = [
    ['GET', '/pm/properties'],
    ['GET', '/pm/properties/prop-1'],
    ['GET', '/pm/units'],
    ['GET', '/pm/units/u-1'],
    ['GET', '/pm/tenants'],
    ['GET', '/pm/tenants/t-1'],
    ['GET', '/pm/maintenance'],
    ['GET', '/pm/maintenance/wo-1'],
    ['GET', '/pm/payments'],
    ['GET', '/pm/payments/pay-1'],
    ['GET', '/pm/documents'],
    ['GET', '/pm/documents/doc-1'],
  ] as const;

  for (const [method, path] of endpoints) {
    it(`${method} ${path} → 403 for TENANT`, async () => {
      activeUser.current = user({ role: 'TENANT' });
      const res = await req(port, method, path);
      expect(res.status).toBe(403);
    });

    it(`${method} ${path} → 403 for OWNER`, async () => {
      activeUser.current = user({ role: 'OWNER' });
      const res = await req(port, method, path);
      expect(res.status).toBe(403);
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════
   Properties — scope isolation
   ═══════════════════════════════════════════════════════════════════ */

describe('Properties', () => {
  it('GET /properties returns only assigned properties for PM_STAFF', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    // Assignment query returns 1 property
    mockQuery
      .mockResolvedValueOnce([{ property_id: 'prop-A' }]) // resolvePMPropertyIds
      .mockResolvedValueOnce([{ id: 'prop-A', name: 'Assigned' }]); // list query
    mockQueryOne.mockResolvedValueOnce({ count: '1' }); // count

    const res = await req(port, 'GET', '/pm/properties');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 1, hasMore: false });
  });

  it('GET /properties returns empty for PM_STAFF with no assignments', async () => {
    activeUser.current = user({ userId: 'pm-lonely' });
    mockQuery.mockResolvedValueOnce([]); // no assignments

    const res = await req(port, 'GET', '/pm/properties');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('GET /properties/:id → 404 for unassigned property', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    // requirePMPropertyAccess: no assignment found
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'GET', '/pm/properties/prop-unassigned');
    expect(res.status).toBe(404);
  });

  it('GET /properties/:id → 200 for assigned property', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    // requirePMPropertyAccess: assignment found
    mockQueryOne
      .mockResolvedValueOnce({ id: 'mpa-1' }) // assignment check
      .mockResolvedValueOnce({ id: 'prop-A', name: 'Assigned', organization_id: 'org-1' }); // detail

    const res = await req(port, 'GET', '/pm/properties/prop-A');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('prop-A');
  });

  it('ORG_ADMIN sees all org properties', async () => {
    activeUser.current = user({ role: 'ORG_ADMIN' });
    mockQuery
      .mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]) // resolvePMPropertyIds
      .mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]); // list
    mockQueryOne.mockResolvedValueOnce({ count: '3' });

    const res = await req(port, 'GET', '/pm/properties');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Units — scope through parent property
   ═══════════════════════════════════════════════════════════════════ */

describe('Units', () => {
  it('GET /units/:id → 404 when parent property not assigned', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    // Unit found in org
    mockQueryOne.mockResolvedValueOnce({ id: 'u-1', property_id: 'prop-unassigned' });
    // requirePMPropertyAccess: no assignment
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'GET', '/pm/units/u-1');
    expect(res.status).toBe(404);
  });

  it('GET /units/:id → 200 when parent property is assigned', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    mockQueryOne
      .mockResolvedValueOnce({ id: 'u-1', property_id: 'prop-A', property_name: 'A' })
      .mockResolvedValueOnce({ id: 'mpa-1' }); // assignment check

    const res = await req(port, 'GET', '/pm/units/u-1');
    expect(res.status).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Tenants — full lineage check
   ═══════════════════════════════════════════════════════════════════ */

describe('Tenants', () => {
  it('GET /tenants returns tenants scoped through full lineage', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    mockQuery
      .mockResolvedValueOnce([{ property_id: 'prop-A' }]) // assignments
      .mockResolvedValueOnce([{ id: 'tp-1', name: 'Tenant A' }]); // tenant list
    mockQueryOne.mockResolvedValueOnce({ count: '1' });

    const res = await req(port, 'GET', '/pm/tenants');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // Verify lineage query includes proper JOINs
    const listCall = mockQuery.mock.calls[1];
    expect(listCall[0]).toContain('tenant_profiles');
    expect(listCall[0]).toContain('JOIN leases');
    expect(listCall[0]).toContain('JOIN units');
  });

  it('GET /tenants/:id → 404 when lineage leads to unassigned property', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    // Tenant found via lineage, property_id is unassigned
    mockQueryOne
      .mockResolvedValueOnce({ id: 'tp-1', property_id: 'prop-unassigned' })
      .mockResolvedValueOnce(null); // requirePMPropertyAccess fails

    const res = await req(port, 'GET', '/pm/tenants/tp-1');
    expect(res.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Maintenance — subresource auth + status enum validation
   ═══════════════════════════════════════════════════════════════════ */

describe('Maintenance', () => {
  it('PATCH /maintenance/:id/status rejects invalid enum values', async () => {
    activeUser.current = user({ userId: 'pm-1' });

    const res = await req(port, 'PATCH', '/pm/maintenance/wo-1/status', { status: 'INVALID' });
    // validateBody rejects invalid status — must not return 200
    expect(res.status).toBeGreaterThanOrEqual(400);
    // DB should never be touched for invalid input
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('PATCH /maintenance/:id/status succeeds with valid enum', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    // Scope check
    mockQueryOne
      .mockResolvedValueOnce({ id: 'wo-1', property_id: 'prop-A' }) // existing WO
      .mockResolvedValueOnce({ id: 'mpa-1' }) // assignment check
      .mockResolvedValueOnce({ id: 'wo-1', status: 'RESOLVED' }); // update result

    const res = await req(port, 'PATCH', '/pm/maintenance/wo-1/status', { status: 'RESOLVED' });
    expect(res.status).toBe(200);
  });

  it('GET /maintenance/:id/comments inherits parent WO authorization', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    // Parent WO scope check
    mockQueryOne
      .mockResolvedValueOnce({ id: 'wo-1', property_id: 'prop-A' })
      .mockResolvedValueOnce({ id: 'mpa-1' }); // assignment check
    // Comments query
    mockQuery.mockResolvedValueOnce([{ id: 'c-1', comment: 'Fixed it' }]);

    const res = await req(port, 'GET', '/pm/maintenance/wo-1/comments');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('POST /maintenance/:id/comments → 404 when parent WO out of scope', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    // Parent WO found but property unassigned
    mockQueryOne
      .mockResolvedValueOnce({ id: 'wo-1', property_id: 'prop-unassigned' })
      .mockResolvedValueOnce(null); // assignment check fails

    const res = await req(port, 'POST', '/pm/maintenance/wo-1/comments', { comment: 'test' });
    expect(res.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Payments — scope through lineage
   ═══════════════════════════════════════════════════════════════════ */

describe('Payments', () => {
  it('GET /payments/:id → 404 for payment on unassigned property', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    mockQueryOne
      .mockResolvedValueOnce({ id: 'pay-1', property_id: 'prop-unassigned' })
      .mockResolvedValueOnce(null);

    const res = await req(port, 'GET', '/pm/payments/pay-1');
    expect(res.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Documents — multi-relationship scope
   ═══════════════════════════════════════════════════════════════════ */

describe('Documents', () => {
  it('GET /documents/:id resolves PROPERTY-linked doc scope', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    mockQueryOne
      .mockResolvedValueOnce({ id: 'doc-1', related_type: 'PROPERTY', related_id: 'prop-A' })
      .mockResolvedValueOnce({ id: 'mpa-1' }); // assignment check

    const res = await req(port, 'GET', '/pm/documents/doc-1');
    expect(res.status).toBe(200);
  });

  it('GET /documents/:id resolves LEASE-linked doc scope', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    mockQueryOne
      .mockResolvedValueOnce({ id: 'doc-2', related_type: 'LEASE', related_id: 'lease-1' })
      .mockResolvedValueOnce({ property_id: 'prop-A' }) // lease → unit → property
      .mockResolvedValueOnce({ id: 'mpa-1' }); // assignment check

    const res = await req(port, 'GET', '/pm/documents/doc-2');
    expect(res.status).toBe(200);
  });

  it('GET /documents/:id → 404 for doc linked to unassigned property', async () => {
    activeUser.current = user({ userId: 'pm-1' });
    mockQueryOne
      .mockResolvedValueOnce({ id: 'doc-3', related_type: 'PROPERTY', related_id: 'prop-unassigned' })
      .mockResolvedValueOnce(null); // assignment check fails

    const res = await req(port, 'GET', '/pm/documents/doc-3');
    expect(res.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Cross-org isolation
   ═══════════════════════════════════════════════════════════════════ */

describe('Cross-org isolation', () => {
  it('PM_STAFF in org-X cannot see properties from org-Y', async () => {
    activeUser.current = user({ userId: 'pm-x', orgId: 'org-X' });
    mockQuery.mockResolvedValueOnce([]); // no assignments in org-X

    const res = await req(port, 'GET', '/pm/properties');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    // Verify orgId used in query
    expect(mockQuery.mock.calls[0][1][0]).toBe('org-X');
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Meta envelope consistency
   ═══════════════════════════════════════════════════════════════════ */

describe('Meta envelope', () => {
  it('list endpoints return { data, meta: { page, limit, total, hasMore } }', async () => {
    activeUser.current = user({ role: 'ORG_ADMIN' });
    mockQuery
      .mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }]) // resolvePMPropertyIds
      .mockResolvedValueOnce([{ id: 'p1' }]); // page 1 of 2
    mockQueryOne.mockResolvedValueOnce({ count: '2' });

    const res = await req(port, 'GET', '/pm/properties?limit=1&page=1');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({
      page: 1,
      limit: 1,
      total: 2,
      hasMore: true,
    });
    // Should NOT have totalPages
    expect(res.body.meta.totalPages).toBeUndefined();
  });
});
