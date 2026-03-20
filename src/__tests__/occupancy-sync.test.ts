/**
 * Internal unit occupancy-sync endpoint tests
 *
 * Covers POST /units/:unitId/occupancy-sync:
 *   - VACANT -> OCCUPIED transition
 *   - Idempotent: setting same status succeeds
 *   - Requires X-Internal-Service-Key
 *   - Rejects invalid status values
 *   - Returns 404 when unit not found
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const { mockQuery, mockQueryOne, activeUser } = vi.hoisted(() => ({
  mockQuery:    vi.fn(),
  mockQueryOne: vi.fn(),
  activeUser:   { current: null as any },
}));

vi.mock('@leasebase/service-common', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@leasebase/service-common')>();
  return {
    ...mod,
    query:    mockQuery,
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
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: '127.0.0.1', port, path, method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...extraHeaders,
        },
      },
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
    if (payload) r.write(payload);
    r.end();
  });
}

const TEST_INTERNAL_KEY = 'test-internal-key-prop';
const validHeaders = { 'x-internal-service-key': TEST_INTERNAL_KEY };

let server: http.Server;
let port: number;

beforeAll(async () => {
  process.env.INTERNAL_SERVICE_KEY = TEST_INTERNAL_KEY;
  const app = express();
  app.use(express.json());
  app.use('/p', unitsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; resolve(); });
  });
});
afterAll(() => server?.close());
beforeEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  activeUser.current = null;
});

// ════════════════════════════════════════════════════════════════════════════
// POST /units/:unitId/occupancy-sync
// ════════════════════════════════════════════════════════════════════════════

describe('POST /units/:unitId/occupancy-sync', () => {
  it('marks unit OCCUPIED and returns updated status', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'unit-1', status: 'OCCUPIED' });

    const res = await req(
      port, 'POST', '/p/units/unit-1/occupancy-sync',
      { status: 'OCCUPIED' },
      validHeaders,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.unitId).toBe('unit-1');
    expect(res.body.data.status).toBe('OCCUPIED');
  });

  it('marks unit VACANT and returns updated status', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'unit-1', status: 'VACANT' });

    const res = await req(
      port, 'POST', '/p/units/unit-1/occupancy-sync',
      { status: 'VACANT' },
      validHeaders,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('VACANT');
  });

  it('is idempotent — setting the same status succeeds', async () => {
    // Setting OCCUPIED when already OCCUPIED is fine (UPDATE returns existing row)
    mockQueryOne.mockResolvedValueOnce({ id: 'unit-1', status: 'OCCUPIED' });

    const res = await req(
      port, 'POST', '/p/units/unit-1/occupancy-sync',
      { status: 'OCCUPIED' },
      validHeaders,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('OCCUPIED');
  });

  it('uses property_service schema-qualified table name', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'unit-1', status: 'OCCUPIED' });

    await req(
      port, 'POST', '/p/units/unit-1/occupancy-sync',
      { status: 'OCCUPIED' },
      validHeaders,
    );

    const sql = mockQueryOne.mock.calls[0][0] as string;
    expect(sql).toContain('property_service.units');
  });

  it('passes unitId as the id filter parameter', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'unit-42', status: 'OCCUPIED' });

    await req(
      port, 'POST', '/p/units/unit-42/occupancy-sync',
      { status: 'OCCUPIED' },
      validHeaders,
    );

    const params = mockQueryOne.mock.calls[0][1] as any[];
    expect(params).toContain('unit-42');
  });

  it('returns 404 when unit not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await req(
      port, 'POST', '/p/units/unit-999/occupancy-sync',
      { status: 'OCCUPIED' },
      validHeaders,
    );

    expect(res.status).toBe(404);
  });

  it('returns 401 without internal service key', async () => {
    const res = await req(
      port, 'POST', '/p/units/unit-1/occupancy-sync',
      { status: 'OCCUPIED' },
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 with wrong internal service key', async () => {
    const res = await req(
      port, 'POST', '/p/units/unit-1/occupancy-sync',
      { status: 'OCCUPIED' },
      { 'x-internal-service-key': 'wrong-key' },
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid status value', async () => {
    const res = await req(
      port, 'POST', '/p/units/unit-1/occupancy-sync',
      { status: 'MAINTENANCE' },
      validHeaders,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when status is missing', async () => {
    const res = await req(
      port, 'POST', '/p/units/unit-1/occupancy-sync',
      {},
      validHeaders,
    );
    expect(res.status).toBe(400);
  });
});

export {};
