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
import { propertiesRouter } from '../routes/properties';

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
  app.use('/properties', propertiesRouter);
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
   Role Guards — TENANT → 403 on write endpoints
   ═══════════════════════════════════════════════════════════════════ */

describe('Role guards', () => {
  const ownerAllowed: [string, string][] = [
    ['GET', '/properties'],
    ['POST', '/properties'],
    ['GET', '/properties/prop-1'],
    ['PUT', '/properties/prop-1'],
  ];

  for (const [method, path] of ownerAllowed) {
    it(`${method} ${path} → 200/201 for OWNER (not 403)`, async () => {
      activeUser.current = owner();
      // Provide mock data so the route can succeed
      if (method === 'GET' && path === '/properties') {
        mockQuery.mockResolvedValueOnce([]);
        mockQueryOne.mockResolvedValueOnce({ count: '0' });
      } else if (method === 'GET') {
        mockQueryOne.mockResolvedValueOnce({ id: 'prop-1', name: 'Test', organization_id: 'org-1' });
      } else if (method === 'POST') {
        mockQueryOne.mockResolvedValueOnce({ id: 'new-1', name: 'New' });
      } else if (method === 'PUT') {
        mockQueryOne.mockResolvedValueOnce({ id: 'prop-1', name: 'Updated' });
      }

      const body = (method === 'POST' || method === 'PUT')
        ? { name: 'Test', addressLine1: '123 Main', city: 'NY', state: 'NY', postalCode: '10001' }
        : undefined;

      const res = await req(port, method, path, body);
      expect(res.status).not.toBe(403);
    });
  }

  it('DELETE /properties/:id → 403 for OWNER (ORG_ADMIN only)', async () => {
    activeUser.current = owner();
    const res = await req(port, 'DELETE', '/properties/prop-1');
    expect(res.status).toBe(403);
  });

  const tenantBlocked: [string, string][] = [
    ['GET', '/properties'],
    ['POST', '/properties'],
    ['GET', '/properties/prop-1'],
    ['PUT', '/properties/prop-1'],
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
    const res = await req(port, 'GET', '/properties');
    expect(res.status).toBe(401);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   OWNER — List properties
   ═══════════════════════════════════════════════════════════════════ */

describe('OWNER list properties', () => {
  it('GET /properties returns org-scoped properties', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([
      { id: 'p1', name: 'Prop A', organization_id: 'org-1' },
      { id: 'p2', name: 'Prop B', organization_id: 'org-1' },
    ]);
    mockQueryOne.mockResolvedValueOnce({ count: '2' });

    const res = await req(port, 'GET', '/properties');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1 });
    // Verify org isolation in query
    expect(mockQuery.mock.calls[0][1][0]).toBe('org-1');
  });

  it('GET /properties returns empty when no properties exist', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: '0' });

    const res = await req(port, 'GET', '/properties');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('GET /properties respects pagination params', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([{ id: 'p1' }]);
    mockQueryOne.mockResolvedValueOnce({ count: '3' });

    const res = await req(port, 'GET', '/properties?page=1&limit=1');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 1, total: 3, totalPages: 3 });
  });
});

/* ═══════════════════════════════════════════════════════════════════
   OWNER — Create property
   ═══════════════════════════════════════════════════════════════════ */

describe('OWNER create property', () => {
  const validBody = {
    name: 'Sunset Apartments',
    addressLine1: '123 Main St',
    city: 'Los Angeles',
    state: 'CA',
    postalCode: '90001',
  };

  it('POST /properties creates and returns 201', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({
      id: 'new-1', organization_id: 'org-1', name: 'Sunset Apartments',
      address_line1: '123 Main St', city: 'Los Angeles', state: 'CA',
      postal_code: '90001', country: 'US',
    });

    const res = await req(port, 'POST', '/properties', validBody);
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('new-1');
    expect(res.body.data.name).toBe('Sunset Apartments');
    // Verify org_id is injected from JWT, not body
    expect(mockQueryOne.mock.calls[0][1][0]).toBe('org-1');
  });

  it('POST /properties with optional addressLine2', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ id: 'new-2', address_line2: 'Suite 200' });

    const res = await req(port, 'POST', '/properties', { ...validBody, addressLine2: 'Suite 200' });
    expect(res.status).toBe(201);
  });

  it('POST /properties rejects missing required fields', async () => {
    activeUser.current = owner();
    const res = await req(port, 'POST', '/properties', { name: 'Only name' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('POST /properties rejects empty name', async () => {
    activeUser.current = owner();
    const res = await req(port, 'POST', '/properties', { ...validBody, name: '' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   OWNER — Get property detail
   ═══════════════════════════════════════════════════════════════════ */

describe('OWNER get property detail', () => {
  it('GET /properties/:id returns property in same org', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({
      id: 'prop-1', organization_id: 'org-1', name: 'Test Property',
    });

    const res = await req(port, 'GET', '/properties/prop-1');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('prop-1');
    // Verify both id and orgId used in query
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['prop-1', 'org-1']);
  });

  it('GET /properties/:id → 404 for non-existent property', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'GET', '/properties/nonexistent');
    expect(res.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   OWNER — Update property (PUT)
   ═══════════════════════════════════════════════════════════════════ */

describe('OWNER update property', () => {
  it('PUT /properties/:id updates and returns 200', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({
      id: 'prop-1', name: 'Updated Name', organization_id: 'org-1',
    });

    const res = await req(port, 'PUT', '/properties/prop-1', { name: 'Updated Name' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated Name');
    // Verify orgId in WHERE clause
    const args = mockQueryOne.mock.calls[0][1];
    expect(args).toContain('org-1');
  });

  it('PUT /properties/:id with empty body returns existing property', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce({ id: 'prop-1', name: 'Existing' });

    const res = await req(port, 'PUT', '/properties/prop-1', {});
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Existing');
  });

  it('PUT /properties/:id → 404 when property not in org', async () => {
    activeUser.current = owner();
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'PUT', '/properties/prop-other-org', { name: 'Hijack' });
    expect(res.status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Cross-org isolation
   ═══════════════════════════════════════════════════════════════════ */

describe('Cross-org isolation', () => {
  it('OWNER in org-X cannot list properties from org-Y', async () => {
    activeUser.current = owner({ orgId: 'org-X' });
    mockQuery.mockResolvedValueOnce([]);
    mockQueryOne.mockResolvedValueOnce({ count: '0' });

    const res = await req(port, 'GET', '/properties');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    // Verify org-X is used, not org-Y
    expect(mockQuery.mock.calls[0][1][0]).toBe('org-X');
  });

  it('OWNER in org-X cannot fetch property belonging to org-Y', async () => {
    activeUser.current = owner({ orgId: 'org-X' });
    // query returns null because org_id WHERE clause filters it out
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'GET', '/properties/prop-in-org-Y');
    expect(res.status).toBe(404);
  });

  it('OWNER in org-X cannot update property in org-Y', async () => {
    activeUser.current = owner({ orgId: 'org-X' });
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(port, 'PUT', '/properties/prop-in-org-Y', { name: 'Hijack' });
    expect(res.status).toBe(404);
  });

  it('OWNER in org-X create always assigns to own org', async () => {
    activeUser.current = owner({ orgId: 'org-X' });
    mockQueryOne.mockResolvedValueOnce({ id: 'new-1', organization_id: 'org-X' });

    const res = await req(port, 'POST', '/properties', {
      name: 'My Prop', addressLine1: '1 St', city: 'C', state: 'S', postalCode: '00000',
    });
    expect(res.status).toBe(201);
    // Verify org-X is used in INSERT
    expect(mockQueryOne.mock.calls[0][1][0]).toBe('org-X');
  });
});

/* ═══════════════════════════════════════════════════════════════════
   Meta envelope consistency
   ═══════════════════════════════════════════════════════════════════ */

describe('Meta envelope', () => {
  it('list returns { data, meta: { page, limit, total, hasMore } }', async () => {
    activeUser.current = owner();
    mockQuery.mockResolvedValueOnce([{ id: 'p1' }]);
    mockQueryOne.mockResolvedValueOnce({ count: '5' });

    const res = await req(port, 'GET', '/properties?limit=2&page=1');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 2, total: 5, totalPages: 3 });
  });
});
