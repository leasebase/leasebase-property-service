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
import { pmDashboardRouter } from '../routes/pm-dashboard';

function req(port: number, method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, body: raw }); }
        });
      },
    );
    r.on('error', reject);
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
  app.use('/pm', pmDashboardRouter);
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

/* ─── Helpers ─── */

/** Stubs the 7 parallel aggregate queries that fire after property IDs are resolved. */
function stubAggregateQueries(data: {
  properties?: any[];
  units?: any[];
  leases?: any[];
  tenants?: any[];
  workOrders?: any[];
  payments?: any[];
  ledgerEntries?: any[];
} = {}) {
  mockQuery
    .mockResolvedValueOnce(data.properties ?? [])   // properties
    .mockResolvedValueOnce(data.units ?? [])         // units
    .mockResolvedValueOnce(data.leases ?? [])        // leases
    .mockResolvedValueOnce(data.tenants ?? [])       // tenants
    .mockResolvedValueOnce(data.workOrders ?? [])    // work_orders
    .mockResolvedValueOnce(data.payments ?? [])      // payments
    .mockResolvedValueOnce(data.ledgerEntries ?? []); // ledger_entries
}

describe('PM Dashboard — data isolation', () => {
  // ── Role guard: TENANT → 403 ──
  describe('Role guard', () => {
    it('returns 403 for TENANT', async () => {
      activeUser.current = user({ role: 'TENANT' });
      const res = await req(port, 'GET', '/pm/dashboard');
      expect(res.status).toBe(403);
    });

    it('returns 403 for OWNER', async () => {
      activeUser.current = user({ role: 'OWNER' });
      const res = await req(port, 'GET', '/pm/dashboard');
      expect(res.status).toBe(403);
    });
  });

  // ── PM_STAFF with assigned properties ──
  describe('PM_STAFF with assigned properties', () => {
    it('returns 200 with scoped dashboard data', async () => {
      activeUser.current = user({ userId: 'pm-1', role: 'PM_STAFF' });

      // First query: manager_property_assignments
      mockQuery.mockResolvedValueOnce([{ property_id: 'prop-1' }]);

      // 7 aggregate queries
      stubAggregateQueries({
        properties: [{ id: 'prop-1', name: 'Main St', status: 'ACTIVE' }],
        units: [{ id: 'unit-1', property_id: 'prop-1', unit_number: '101', status: 'OCCUPIED' }],
        leases: [{ id: 'lease-1', unit_id: 'unit-1', status: 'ACTIVE', rent_amount: 1200 }],
      });

      const res = await req(port, 'GET', '/pm/dashboard');
      expect(res.status).toBe(200);

      expect(res.body.kpis.totalProperties).toBe(1);
      expect(res.body.kpis.totalUnits).toBe(1);
      expect(res.body.kpis.occupiedUnits).toBe(1);
      expect(res.body.kpis.monthlyScheduledRent).toBe(1200);
      expect(res.body.properties).toHaveLength(1);
      expect(res.body.leases).toHaveLength(1);

      // Verify the assignment query was scoped to user + org
      const firstCall = mockQuery.mock.calls[0];
      expect(firstCall[0]).toContain('manager_property_assignments');
      expect(firstCall[1]).toEqual(['org-1', 'pm-1']);
    });
  });

  // ── PM_STAFF with no assignments → empty dashboard ──
  describe('PM_STAFF with no assignments', () => {
    it('returns 200 with empty dashboard payload', async () => {
      activeUser.current = user({ userId: 'pm-lonely', role: 'PM_STAFF' });

      // Assignment query returns nothing
      mockQuery.mockResolvedValueOnce([]);

      const res = await req(port, 'GET', '/pm/dashboard');
      expect(res.status).toBe(200);

      expect(res.body.kpis.totalProperties).toBe(0);
      expect(res.body.kpis.totalUnits).toBe(0);
      expect(res.body.kpis.vacancyRate).toBe(0);
      expect(res.body.properties).toEqual([]);
      expect(res.body.leases).toEqual([]);
      expect(res.body.tasks).toEqual([]);

      // No aggregate queries should fire
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  // ── PM_STAFF cannot see unassigned properties ──
  describe('PM_STAFF scope isolation', () => {
    it('only queries for assigned property IDs', async () => {
      activeUser.current = user({ userId: 'pm-2', role: 'PM_STAFF' });

      // PM is assigned to prop-A only (not prop-B)
      mockQuery.mockResolvedValueOnce([{ property_id: 'prop-A' }]);

      stubAggregateQueries({
        properties: [{ id: 'prop-A', name: 'Assigned', status: 'ACTIVE' }],
      });

      const res = await req(port, 'GET', '/pm/dashboard');
      expect(res.status).toBe(200);

      // Verify properties query only includes prop-A
      const propertiesCall = mockQuery.mock.calls[1]; // second call = properties aggregate
      expect(propertiesCall[0]).toContain('id IN');
      expect(propertiesCall[1]).toContain('prop-A');
      expect(propertiesCall[1]).not.toContain('prop-B');
    });
  });

  // ── Cross-org blocked ──
  describe('Cross-org isolation', () => {
    it('scopes assignment query to requesting user orgId', async () => {
      activeUser.current = user({ userId: 'pm-x', orgId: 'org-X', role: 'PM_STAFF' });

      // No assignments for this org
      mockQuery.mockResolvedValueOnce([]);

      const res = await req(port, 'GET', '/pm/dashboard');
      expect(res.status).toBe(200);

      // Verify orgId used in assignment query
      const firstCall = mockQuery.mock.calls[0];
      expect(firstCall[1][0]).toBe('org-X');
    });
  });

  // ── ORG_ADMIN sees all org properties ──
  describe('ORG_ADMIN access', () => {
    it('returns 200 querying all org properties (not assignments)', async () => {
      activeUser.current = user({ userId: 'admin-1', role: 'ORG_ADMIN' });

      // Admin path: SELECT id FROM properties WHERE organization_id = $1
      mockQuery.mockResolvedValueOnce([{ id: 'prop-1' }, { id: 'prop-2' }]);

      stubAggregateQueries({
        properties: [
          { id: 'prop-1', name: 'First', status: 'ACTIVE' },
          { id: 'prop-2', name: 'Second', status: 'ACTIVE' },
        ],
        units: [
          { id: 'u1', property_id: 'prop-1', status: 'OCCUPIED' },
          { id: 'u2', property_id: 'prop-2', status: 'VACANT' },
        ],
      });

      const res = await req(port, 'GET', '/pm/dashboard');
      expect(res.status).toBe(200);

      expect(res.body.kpis.totalProperties).toBe(2);
      expect(res.body.kpis.totalUnits).toBe(2);

      // Admin query goes to properties table, not manager_property_assignments
      const firstCall = mockQuery.mock.calls[0];
      expect(firstCall[0]).toContain('FROM properties');
      expect(firstCall[0]).not.toContain('manager_property_assignments');
    });
  });

  // ── Unauthenticated → 401 ──
  describe('Unauthenticated', () => {
    it('returns 401 when no user', async () => {
      activeUser.current = null;
      const res = await req(port, 'GET', '/pm/dashboard');
      expect(res.status).toBe(401);
    });
  });
});
