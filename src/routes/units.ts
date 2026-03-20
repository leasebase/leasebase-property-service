import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError, AppError, logger,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

// ── Internal service key validation ──────────────────────────────────────────
function validateInternalKey(req: Request, res: Response): boolean {
  const configuredKey = process.env.INTERNAL_SERVICE_KEY || '';
  const key = req.headers['x-internal-service-key'];
  if (!configuredKey || key !== configuredKey) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing internal service key' } });
    return false;
  }
  return true;
}

const router = Router();

const createUnitSchema = z.object({
  unitNumber: z.string().min(1),
  bedrooms: z.number().int().min(0),
  bathrooms: z.number().min(0),
  squareFeet: z.number().int().optional(),
  rentAmount: z.number().int().min(0).default(0),
  // Default status is VACANT — reflects the preferred business vocabulary for
  // an unoccupied unit (AVAILABLE was renamed to VACANT in migration 002).
  status: z.string().default('VACANT'),
});

const updateUnitSchema = createUnitSchema.partial();

// GET /:propertyId/units - List units for property
router.get('/:propertyId/units', requireAuth,
  requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const offset = (pg.page - 1) * pg.limit;

      const [rows, countResult] = await Promise.all([
        query(
          `SELECT * FROM units WHERE property_id = $1 AND organization_id = $2 ORDER BY unit_number ASC LIMIT $3 OFFSET $4`,
          [req.params.propertyId, user.orgId, pg.limit, offset]
        ),
        queryOne<{ count: string }>(
          `SELECT COUNT(*) as count FROM units WHERE property_id = $1 AND organization_id = $2`,
          [req.params.propertyId, user.orgId]
        ),
      ]);

      const total = Number(countResult?.count || 0);
      res.json({ data: rows, meta: paginationMeta(total, pg) });
    } catch (err) { next(err); }
  }
);

// POST /:propertyId/units - Create unit
router.post('/:propertyId/units', requireAuth,
  requireRole(UserRole.OWNER),
  validateBody(createUnitSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { unitNumber, bedrooms, bathrooms, squareFeet, rentAmount, status } = req.body;

      const row = await queryOne(
        `INSERT INTO units (organization_id, property_id, unit_number, bedrooms, bathrooms, square_feet, rent_amount, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [user.orgId, req.params.propertyId, unitNumber, bedrooms, bathrooms, squareFeet || null, rentAmount, status]
      );

      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  }
);

// GET /units/:unitId - Get unit
router.get('/units/:unitId', requireAuth,
  requireRole(UserRole.OWNER, UserRole.TENANT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `SELECT * FROM units WHERE id = $1 AND organization_id = $2`,
        [req.params.unitId, user.orgId]
      );
      if (!row) throw new NotFoundError('Unit not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  }
);

// PUT /units/:unitId - Update unit
router.put('/units/:unitId', requireAuth,
  requireRole(UserRole.OWNER),
  validateBody(updateUnitSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const fields = req.body;
      const sets: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      for (const [key, val] of Object.entries(fields)) {
        const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        sets.push(`${col} = $${idx}`);
        values.push(val);
        idx++;
      }

      if (sets.length === 0) {
        const existing = await queryOne(`SELECT * FROM units WHERE id = $1 AND organization_id = $2`, [req.params.unitId, user.orgId]);
        if (!existing) throw new NotFoundError('Unit not found');
        return res.json({ data: existing });
      }

      sets.push(`updated_at = NOW()`);
      values.push(req.params.unitId, user.orgId);

      const row = await queryOne(
        `UPDATE units SET ${sets.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
        values
      );
      if (!row) throw new NotFoundError('Unit not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  }
);

// DELETE /units/:unitId
router.delete('/units/:unitId', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `DELETE FROM units WHERE id = $1 AND organization_id = $2 RETURNING id`,
        [req.params.unitId, user.orgId]
      );
      if (!row) throw new NotFoundError('Unit not found');
      res.status(204).send();
    } catch (err) { next(err); }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// INTERNAL SERVICE-TO-SERVICE ENDPOINTS
// Protected by X-Internal-Service-Key header (not by JWT auth).
// Called by lease-service during lease activation.
// ══════════════════════════════════════════════════════════════════════════════

const occupancySyncSchema = z.object({
  status: z.enum(['VACANT', 'OCCUPIED']),
});

/**
 * POST /units/:unitId/occupancy-sync
 *
 * Internal-only endpoint to synchronize unit occupancy status.
 * Called by lease-service after lease activation/deactivation.
 *
 * - Idempotent: setting the same status is a no-op (updates 0 rows, no error)
 * - Protected by X-Internal-Service-Key header
 */
router.post('/units/:unitId/occupancy-sync',
  async (req: Request, res: Response, next: NextFunction) => {
    if (!validateInternalKey(req, res)) return;
    try {
      const { unitId } = req.params;

      const parseResult = occupancySyncSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: parseResult.error.message },
        });
      }

      const { status } = parseResult.data;

      const row = await queryOne<{ id: string; status: string }>(
        `UPDATE property_service.units
         SET status = $1, updated_at = NOW()
         WHERE id::text = $2
         RETURNING id, status`,
        [status, unitId],
      );

      if (!row) throw new NotFoundError('Unit not found');

      logger.info({ unitId, status }, 'Unit occupancy synced');

      res.json({ data: { unitId: row.id, status: row.status } });
    } catch (err) { next(err); }
  },
);

export { router as unitsRouter };
