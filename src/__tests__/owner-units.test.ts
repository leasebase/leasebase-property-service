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
import { unitsRouter } from '../routes/units';

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

const owner = (overrides: Record<string, any> = {}) => ({
  sub: 'owner-1', userId: 'owner-1', orgId: 'org-1', email: 'owner@test.com',
  role: 'OWNER', name: 'Owner User', scopes: ['api/read', 'api/write'],
  ...overrides,
});

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mount at /properties to match real app routing: /internal/properties
  app.use('/properties', unitsRouter);
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
   Role Guards
   ═══════════════════════════════════════════════════════════════════ */

describe('Role guards', () => {
  const ownerAllowed: [string, string][] = [
    ['GET', '/properties/prop-1/units'],
    ['POST', '/properties/prop-1/units'],
    ['GET', '/properties/units/unit-1'],
    ['PUT', '/properties/units/unit-1'],
  ];

  for (const [method, path] of ownerAllowed) {
    it(`${method} ${path} → not 403 for OWNER`, async () => {
      activeUser.current = owner();
      if (method === 'GET' && path.endsWith('/units')) {
        mockQuery.mockResolvedValueOnce([]);
        mockQueryOne.mockResolvedValueOnce({ count: '0' });
      } else if (method === 'GET') {
        mockQueryOne.mockResolvedValueOnce({ id: 'unit-1', organization_id: 'org-1' });
      } else if (method === 'POST') {
        mockQueryOne.mockResolvedValueOnce({ id: 'new-u1' });
      } else if (method === 'PUT') {
        mockQueryOne.mockResolvedValueOnce({ id: 'unit-1' });
      }

      const body = (method === 'POST' || method === 'PUT')
        ? { unitNumber: '101', bedrooms: 2, bathrooms: 1, rentAmount: 150000 }
        : undefined;

      const res = await req(port, method, path, body);
      expect(res.status).not.toBe(403);
    });
  }

  it('DELETE /properties/units/:unitId → 403 for OWNER (ORG_ADMIN only)', async () => {
    activeUser.current = owner();
    const res = await req(port, 'DELETE', '/properties/units/unit-1');
    expect(res.status).toBe(403);
  });

  it('TENANT can GET /properties/units/:unitId (read access)', async () => {
    activeUser.current = owner({ role: 'TENANT' });
    mockQueryOne.mockResolvedValueOnce({ id: 'unit-1', organization_id: 'org-1' });

    const res = await req(port, 'GET', '/properties/units/unit-1');
    expect(res.status).toBe(200);
  });

  const tenantBlocked: [string, string][] = [
    ['GET', '/properties/prop-1/units'],
    ['POST', '/properties/prop-1/units'],
    ['PUT', '/properties/units/unit-1'],
  ];

  for (const [method, path] of tenantBlocked) {
    it(`${method} ${path} → 403 for TENANT`, async () => {
      activeUser.current = owner({ role: 'TENANT' });
      const res = await req(port, method, path);
      expect(res.status).toBe(403);
    });
  }

  it('unauthenticated requests → 401', async () => {
    activeUser.current = null;
    const res = await req(port, 'GET', '/properties/prop-1/units');
    expect(res.status).toBe(401);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   OWNER — List units for property
   ═══════════════════════════════════════════════════════════════════ */

describe('OWNER list units', () => {
  it('GET /:propertyId/units returns units scoped by property + org', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([
      { id: 'u1', unit_number: '101', property_id: 'prop-1' },
      { id: 'u2', unit_number: '102', property_id: 'prop-1' },
    ]);
    mockQueryOne.mockResolvedValueOnce({ count: '2' });

    const res = await req(port, 'GET', '/properties/prop-1/units');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1 });
    // Verify property_id and org_id used in query
    expect(mockQuery.mock.calls[0][1][0]).toBe('prop-1');
    expect(mockQuery.mock.calls[0][1][1]).toBe('org-1');
  });

  it('GET /:propertyId/units returns empty for property with no units', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: '0' });

    const res = await req(port, 'GET', '/properties/prop-1/units');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('GET /:propertyId/units respects pagination', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([{ id: 'u1' }]);
    mockQueryOne.mockResolvedValueOnce({ count: '5' });

    const res = await req(port, 'GET', '/properties/prop-1/units?page=1&limit=1');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 1, total: 5, totalPages: 5 });
  });
});

/* ═══════════════════════════════════════════════════════════════════
   OWNER — Create unit
   ═══════════════════════════════════════════════════════════════════ */

describe('OWNER create unit', () => {
  const validBody = {
    unitNumber: '101',
    bedrooms: 2,
    bathrooms: 1.5,
    squareFeet: 850,
    rentAmount: 150000,
  };

  it('POST /:propertyId/units creates and returns 201', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({
      id: 'new-u1', organization_id: 'org-1', property_id: 'prop-1',
      unit_number: '101', bedrooms: 2, bathrooms: 1.5, square_feet: 850,
      rent_amount: 150000, status: 'AVAILABLE',
    });

    const res = await req(port, 'POST', '/properties/prop-1/units', validBody);
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('new-u1');
    expect(res.body.data.unit_number).toBe('101');
    // Verify org_id and property_id in INSERT
    const args = mockQueryOne.mock.calls[0][1];
    expect(args[0]).toBe('org-1');
    expect(args[1]).toBe('prop-1');
  });

  it('POST /:propertyId/units defaults status to AVAILABLE', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ id: 'new-u2', status: 'AVAILABLE' });

    const res = await req(port, 'POST', '/properties/prop-1/units', validBody);
    expect(res.status).toBe(201);
    // The default status is applied by zod schema
    const args = mockQueryOne.mock.calls[0][1];
    expect(args[args.length - 1]).toBe('AVAILABLE');
  });

  it('POST /:propertyId/units with custom status', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ id: 'new-u3', status: 'OCCUPIED' });

    const res = await req(port, 'POST', '/properties/prop-1/units', { ...validBody, status: 'OCCUPIED' });
    expect(res.status).toBe(201);
  });

  it('POST /:propertyId/units rejects missing required fields', async () => {
    activeUser.current = owner();
    const res = await req(port, 'POST', '/properties/prop-1/units', { unitNumber: '101' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('POST /:propertyId/units rejects negative bedrooms', async () => {
    activeUser.current = owner();
    const res = await req(port, 'POST', '/properties/prop-1/units', { ...validBody, bedrooms: -1 });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST /:propertyId/units rejects negative rentAmount', async () => {
    activeUser.current = owner();
    const res = await req(port, 'POST', '/properties/prop-1/units', { ...validBody, rentAmount: -100 });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   OWNER — Get unit detail
   ═══════════════════════════════════════════════════════════════════ */

describe('OWNER get unit detail', () => {
  it('GET /units/:unitId returns unit in same org', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({
      id: 'unit-1', organization_id: 'org-1', property_id: 'prop-1',
      unit_number: '101', bedrooms: 2,
    });

    const res = await req(port, 'GET', '/properties/units/unit-1');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('unit-1');
    // Verify id and orgId in query
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['unit-1', 'org-1']);
  });

  it('GET /units/:unitId → 404 for non-existent unit', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'GET', '/properties/units/nonexistent');
    expect(res.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   OWNER — Update unit (PUT)
   ═══════════════════════════════════════════════════════════════════ */

describe('OWNER update unit', () => {
  it('PUT /units/:unitId updates and returns 200', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({
      id: 'unit-1', unit_number: '101A', rent_amount: 200000,
    });

    const res = await req(port, 'PUT', '/properties/units/unit-1', {
      unitNumber: '101A', rentAmount: 200000,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.unit_number).toBe('101A');
    // Verify orgId in WHERE clause
    const args = mockQueryOne.mock.calls[0][1];
    expect(args).toContain('org-1');
  });

  it('PUT /units/:unitId with empty body returns existing unit', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ id: 'unit-1', unit_number: '101' });

    const res = await req(port, 'PUT', '/properties/units/unit-1', {});
    expect(res.status).toBe(200);
    expect(res.body.data.unit_number).toBe('101');
  });

  it('PUT /units/:unitId → 404 when unit not in org', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'PUT', '/properties/units/unit-other-org', { unitNumber: '999' });
    expect(res.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Cross-org isolation
   ═══════════════════════════════════════════════════════════════════ */

describe('Cross-org isolation', () => {
  it('OWNER in org-X cannot list units for a property in org-Y', async () => {
    activeUser.current = owner({ orgId: 'org-X' });
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: '0' });

    const res = await req(port, 'GET', '/properties/prop-in-org-Y/units');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    // org-X used in WHERE
    expect(mockQuery.mock.calls[0][1][1]).toBe('org-X');
  });

  it('OWNER in org-X cannot fetch unit belonging to org-Y', async () => {
    activeUser.current = owner({ orgId: 'org-X' });
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'GET', '/properties/units/unit-in-org-Y');
    expect(res.status).toBe(404);
  });

  it('OWNER in org-X cannot update unit in org-Y', async () => {
    activeUser.current = owner({ orgId: 'org-X' });
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'PUT', '/properties/units/unit-in-org-Y', { unitNumber: 'Hijack' });
    expect(res.status).toBe(404);
  });

  it('OWNER in org-X create unit always uses own org', async () => {
    activeUser.current = owner({ orgId: 'org-X' });
    mockQueryOne.mockResolvedValueOnce({ id: 'new-u1', organization_id: 'org-X' });

    const res = await req(port, 'POST', '/properties/prop-1/units', {
      unitNumber: '101', bedrooms: 1, bathrooms: 1, rentAmount: 100000,
    });
    expect(res.status).toBe(201);
    // Verify org-X in INSERT
    expect(mockQueryOne.mock.calls[0][1][0]).toBe('org-X');
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Meta envelope consistency
   ═══════════════════════════════════════════════════════════════════ */

describe('Meta envelope', () => {
  it('list returns { data, meta: { page, limit, total, hasMore } }', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([{ id: 'u1' }]);
    mockQueryOne.mockResolvedValueOnce({ count: '10' });

    const res = await req(port, 'GET', '/properties/prop-1/units?limit=3&page=1');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 3, total: 10, totalPages: 4 });
  });
});
