/**
 * PM Phase 2 Routes
 *
 * All PM-scoped endpoints for drill-down pages. This is a thin
 * aggregation/facade layer — it reads across domain tables but does
 * not re-own domain logic from maintenance/payment/document services.
 *
 * Scope rules (server-side, never trusts client):
 * - ORG_ADMIN: all org properties
 * - PM_STAFF: assigned properties only (via manager_property_assignments)
 * - OWNER/TENANT: 403
 * - Out-of-scope resource: 404
 *
 * All list endpoints: { data: [...], meta: { page, limit, total, hasMore } }
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, validateBody,
  query, queryOne, NotFoundError,
  parsePagination,
  type AuthenticatedRequest,
} from '@leasebase/service-common';
import {
  requirePMRole,
  resolvePMPropertyIds,
  requirePMPropertyAccess,
  buildScopeParams,
} from './pm-scope';

const router = Router();

/* ─── Helpers ─── */

function pmMeta(total: number, pg: { page: number; limit: number }) {
  return { page: pg.page, limit: pg.limit, total, hasMore: pg.page * pg.limit < total };
}

/* ═══════════════════════════════════════════════════════════════════════
   PROPERTIES
   ═══════════════════════════════════════════════════════════════════════ */

// GET /properties — paginated, PM-scoped
router.get('/properties', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const propertyIds = await resolvePMPropertyIds(user);

      if (propertyIds.length === 0) {
        return res.json({ data: [], meta: pmMeta(0, pg) });
      }

      const { placeholders, baseParams } = buildScopeParams(user.orgId, propertyIds);
      const offset = (pg.page - 1) * pg.limit;

      const [rows, countResult] = await Promise.all([
        query(
          `SELECT * FROM properties
           WHERE organization_id = $1 AND id IN (${placeholders})
           ORDER BY name ASC LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
          [...baseParams, pg.limit, offset],
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM properties
           WHERE organization_id = $1 AND id IN (${placeholders})`,
          baseParams,
        ),
      ]);

      res.json({ data: rows, meta: pmMeta(Number(countResult?.count || 0), pg) });
    } catch (err) { next(err); }
  },
);

// GET /properties/:id — detail
router.get('/properties/:id', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      await requirePMPropertyAccess(req.params.id, user);

      const row = await queryOne(
        `SELECT * FROM properties WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Property not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   UNITS
   ═══════════════════════════════════════════════════════════════════════ */

// GET /units — paginated, scoped via property assignment
router.get('/units', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const propertyIds = await resolvePMPropertyIds(user);

      if (propertyIds.length === 0) {
        return res.json({ data: [], meta: pmMeta(0, pg) });
      }

      const { placeholders, baseParams } = buildScopeParams(user.orgId, propertyIds);
      const offset = (pg.page - 1) * pg.limit;

      const [rows, countResult] = await Promise.all([
        query(
          `SELECT u.*, p.name as property_name FROM units u
           JOIN properties p ON p.id = u.property_id
           WHERE u.organization_id = $1 AND u.property_id IN (${placeholders})
           ORDER BY p.name ASC, u.unit_number ASC
           LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
          [...baseParams, pg.limit, offset],
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM units
           WHERE organization_id = $1 AND property_id IN (${placeholders})`,
          baseParams,
        ),
      ]);

      res.json({ data: rows, meta: pmMeta(Number(countResult?.count || 0), pg) });
    } catch (err) { next(err); }
  },
);

// GET /units/:id — detail, scope-checked through parent property
router.get('/units/:id', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne<{ property_id: string }>(
        `SELECT u.*, p.name as property_name FROM units u
         JOIN properties p ON p.id = u.property_id
         WHERE u.id = $1 AND u.organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Unit not found');
      await requirePMPropertyAccess(row.property_id, user);
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   TENANTS
   Full lineage: property assignment → unit → lease → tenant_profile
   ═══════════════════════════════════════════════════════════════════════ */

// GET /tenants — paginated, full lineage check
router.get('/tenants', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const propertyIds = await resolvePMPropertyIds(user);

      if (propertyIds.length === 0) {
        return res.json({ data: [], meta: pmMeta(0, pg) });
      }

      const { placeholders, baseParams } = buildScopeParams(user.orgId, propertyIds);
      const offset = (pg.page - 1) * pg.limit;

      const [rows, countResult] = await Promise.all([
        query(
          `SELECT tp.id, tp.user_id, tp.lease_id, usr.name, usr.email, tp.phone,
                  u.unit_number, p.name as property_name
           FROM tenant_profiles tp
           JOIN users usr ON usr.id = tp.user_id
           JOIN leases l ON l.id = tp.lease_id
           JOIN units u ON u.id = l.unit_id
           JOIN properties p ON p.id = u.property_id
           WHERE l.organization_id = $1 AND u.property_id IN (${placeholders})
           ORDER BY usr.name ASC
           LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
          [...baseParams, pg.limit, offset],
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) as count
           FROM tenant_profiles tp
           JOIN leases l ON l.id = tp.lease_id
           JOIN units u ON u.id = l.unit_id
           WHERE l.organization_id = $1 AND u.property_id IN (${placeholders})`,
          baseParams,
        ),
      ]);

      res.json({ data: rows, meta: pmMeta(Number(countResult?.count || 0), pg) });
    } catch (err) { next(err); }
  },
);

// GET /tenants/:id — detail, full lineage check
router.get('/tenants/:id', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne<{ property_id: string }>(
        `SELECT tp.id, tp.user_id, tp.lease_id, usr.name, usr.email, tp.phone,
                u.unit_number, u.property_id, p.name as property_name,
                l.start_date, l.end_date, l.rent_amount, l.status as lease_status
         FROM tenant_profiles tp
         JOIN users usr ON usr.id = tp.user_id
         JOIN leases l ON l.id = tp.lease_id
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
         WHERE tp.id = $1 AND l.organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Tenant not found');
      await requirePMPropertyAccess(row.property_id, user);
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   MAINTENANCE (work orders)
   Scope: property assignment → unit → work_order
   ═══════════════════════════════════════════════════════════════════════ */

// GET /maintenance — paginated
router.get('/maintenance', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const propertyIds = await resolvePMPropertyIds(user);

      if (propertyIds.length === 0) {
        return res.json({ data: [], meta: pmMeta(0, pg) });
      }

      const { placeholders, baseParams } = buildScopeParams(user.orgId, propertyIds);
      const offset = (pg.page - 1) * pg.limit;

      const [rows, countResult] = await Promise.all([
        query(
          `SELECT wo.*, u.unit_number, p.name as property_name
           FROM work_orders wo
           JOIN units u ON u.id = wo.unit_id
           JOIN properties p ON p.id = u.property_id
           WHERE wo.organization_id = $1 AND u.property_id IN (${placeholders})
           ORDER BY wo.created_at DESC
           LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
          [...baseParams, pg.limit, offset],
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) as count
           FROM work_orders wo
           JOIN units u ON u.id = wo.unit_id
           WHERE wo.organization_id = $1 AND u.property_id IN (${placeholders})`,
          baseParams,
        ),
      ]);

      res.json({ data: rows, meta: pmMeta(Number(countResult?.count || 0), pg) });
    } catch (err) { next(err); }
  },
);

// GET /maintenance/:id — detail, scope-checked
router.get('/maintenance/:id', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne<{ property_id: string }>(
        `SELECT wo.*, u.unit_number, u.property_id, p.name as property_name
         FROM work_orders wo
         JOIN units u ON u.id = wo.unit_id
         JOIN properties p ON p.id = u.property_id
         WHERE wo.id = $1 AND wo.organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Work order not found');
      await requirePMPropertyAccess(row.property_id, user);
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

// PATCH /maintenance/:id/status — update status with enum validation
const maintenanceStatusSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']),
});

router.patch('/maintenance/:id/status', requireAuth, requirePMRole,
  validateBody(maintenanceStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      // Verify scope first
      const existing = await queryOne<{ property_id: string }>(
        `SELECT wo.id, u.property_id
         FROM work_orders wo
         JOIN units u ON u.id = wo.unit_id
         WHERE wo.id = $1 AND wo.organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!existing) throw new NotFoundError('Work order not found');
      await requirePMPropertyAccess(existing.property_id, user);

      const row = await queryOne(
        `UPDATE work_orders SET status = $1, updated_at = NOW()
         WHERE id = $2 AND organization_id = $3 RETURNING *`,
        [req.body.status, req.params.id, user.orgId],
      );
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

// GET /maintenance/:id/comments — inherits parent WO auth
router.get('/maintenance/:id/comments', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      // Verify parent work order scope
      const wo = await queryOne<{ property_id: string }>(
        `SELECT wo.id, u.property_id
         FROM work_orders wo
         JOIN units u ON u.id = wo.unit_id
         WHERE wo.id = $1 AND wo.organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!wo) throw new NotFoundError('Work order not found');
      await requirePMPropertyAccess(wo.property_id, user);

      const rows = await query(
        `SELECT wc.*, usr.name as author_name
         FROM work_order_comments wc
         JOIN users usr ON wc.user_id = usr.id
         WHERE wc.work_order_id = $1
         ORDER BY wc.created_at ASC`,
        [req.params.id],
      );
      res.json({ data: rows });
    } catch (err) { next(err); }
  },
);

// POST /maintenance/:id/comments — inherits parent WO auth
router.post('/maintenance/:id/comments', requireAuth, requirePMRole,
  validateBody(z.object({ comment: z.string().min(1) })),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      // Verify parent work order scope
      const wo = await queryOne<{ property_id: string }>(
        `SELECT wo.id, u.property_id
         FROM work_orders wo
         JOIN units u ON u.id = wo.unit_id
         WHERE wo.id = $1 AND wo.organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!wo) throw new NotFoundError('Work order not found');
      await requirePMPropertyAccess(wo.property_id, user);

      const row = await queryOne(
        `INSERT INTO work_order_comments (work_order_id, user_id, comment)
         VALUES ($1, $2, $3) RETURNING *`,
        [req.params.id, user.userId, req.body.comment],
      );
      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   PAYMENTS
   Scope: property assignment → unit → lease → payment
   ═══════════════════════════════════════════════════════════════════════ */

// GET /payments — paginated
router.get('/payments', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const propertyIds = await resolvePMPropertyIds(user);

      if (propertyIds.length === 0) {
        return res.json({ data: [], meta: pmMeta(0, pg) });
      }

      const { placeholders, baseParams } = buildScopeParams(user.orgId, propertyIds);
      const offset = (pg.page - 1) * pg.limit;

      const [rows, countResult] = await Promise.all([
        query(
          `SELECT pay.*, u.unit_number, p.name as property_name
           FROM payments pay
           JOIN leases l ON l.id = pay.lease_id
           JOIN units u ON u.id = l.unit_id
           JOIN properties p ON p.id = u.property_id
           WHERE pay.organization_id = $1 AND u.property_id IN (${placeholders})
           ORDER BY pay.created_at DESC
           LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
          [...baseParams, pg.limit, offset],
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) as count
           FROM payments pay
           JOIN leases l ON l.id = pay.lease_id
           JOIN units u ON u.id = l.unit_id
           WHERE pay.organization_id = $1 AND u.property_id IN (${placeholders})`,
          baseParams,
        ),
      ]);

      res.json({ data: rows, meta: pmMeta(Number(countResult?.count || 0), pg) });
    } catch (err) { next(err); }
  },
);

// GET /payments/:id — detail, scope-checked
router.get('/payments/:id', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne<{ property_id: string }>(
        `SELECT pay.*, u.unit_number, u.property_id, p.name as property_name
         FROM payments pay
         JOIN leases l ON l.id = pay.lease_id
         JOIN units u ON u.id = l.unit_id
         JOIN properties p ON p.id = u.property_id
         WHERE pay.id = $1 AND pay.organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!row) throw new NotFoundError('Payment not found');
      await requirePMPropertyAccess(row.property_id, user);
      res.json({ data: row });
    } catch (err) { next(err); }
  },
);

/* ═══════════════════════════════════════════════════════════════════════
   DOCUMENTS
   Scope: property-linked, unit-linked, and lease-linked documents
   under assigned properties.
   ═══════════════════════════════════════════════════════════════════════ */

// GET /documents — paginated, scoped through multiple relationship types
router.get('/documents', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const propertyIds = await resolvePMPropertyIds(user);

      if (propertyIds.length === 0) {
        return res.json({ data: [], meta: pmMeta(0, pg) });
      }

      const { placeholders, baseParams } = buildScopeParams(user.orgId, propertyIds);
      const offset = (pg.page - 1) * pg.limit;

      // Documents linked to properties, units, or leases under assigned properties
      const scopeCondition = `(
        (d.related_type = 'PROPERTY' AND d.related_id IN (${placeholders}))
        OR (d.related_type = 'UNIT' AND d.related_id IN (
          SELECT u.id FROM units u WHERE u.property_id IN (${placeholders})
        ))
        OR (d.related_type = 'LEASE' AND d.related_id IN (
          SELECT l.id FROM leases l JOIN units u ON u.id = l.unit_id WHERE u.property_id IN (${placeholders})
        ))
      )`;

      const [rows, countResult] = await Promise.all([
        query(
          `SELECT d.* FROM documents d
           WHERE d.organization_id = $1 AND ${scopeCondition}
           ORDER BY d.created_at DESC
           LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
          [...baseParams, pg.limit, offset],
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM documents d
           WHERE d.organization_id = $1 AND ${scopeCondition}`,
          baseParams,
        ),
      ]);

      res.json({ data: rows, meta: pmMeta(Number(countResult?.count || 0), pg) });
    } catch (err) { next(err); }
  },
);

// GET /documents/:id — detail, scope-checked
router.get('/documents/:id', requireAuth, requirePMRole,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const doc = await queryOne<{ related_type: string; related_id: string }>(
        `SELECT * FROM documents WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId],
      );
      if (!doc) throw new NotFoundError('Document not found');

      // Resolve property from document relationship
      let propertyId: string | null = null;
      if (doc.related_type === 'PROPERTY') {
        propertyId = doc.related_id;
      } else if (doc.related_type === 'UNIT') {
        const unit = await queryOne<{ property_id: string }>(
          `SELECT property_id FROM units WHERE id = $1 AND organization_id = $2`,
          [doc.related_id, user.orgId],
        );
        propertyId = unit?.property_id ?? null;
      } else if (doc.related_type === 'LEASE') {
        const lease = await queryOne<{ property_id: string }>(
          `SELECT u.property_id FROM leases l
           JOIN units u ON u.id = l.unit_id
           WHERE l.id = $1 AND l.organization_id = $2`,
          [doc.related_id, user.orgId],
        );
        propertyId = lease?.property_id ?? null;
      }

      if (!propertyId) throw new NotFoundError('Document not found');
      await requirePMPropertyAccess(propertyId, user);
      res.json({ data: doc });
    } catch (err) { next(err); }
  },
);

export { router as pmRoutesRouter };
