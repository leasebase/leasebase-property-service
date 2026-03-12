import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  requireAuth, requireRole, validateBody,
  query, queryOne, NotFoundError,
  parsePagination, paginationMeta,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

const createPropertySchema = z.object({
  name: z.string().min(1).max(255),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().default('US'),
});

const updatePropertySchema = createPropertySchema.partial();

// GET / - List properties
router.get('/', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const pg = parsePagination(req.query as Record<string, unknown>);
      const offset = (pg.page - 1) * pg.limit;

      const [rows, countResult] = await Promise.all([
        query(
          `SELECT * FROM properties WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [user.orgId, pg.limit, offset]
        ),
        queryOne<{ count: string }>(`SELECT COUNT(*) as count FROM properties WHERE organization_id = $1`, [user.orgId]),
      ]);

      const total = Number(countResult?.count || 0);
      res.json({ data: rows, meta: paginationMeta(total, pg) });
    } catch (err) { next(err); }
  }
);

// POST / - Create property
router.post('/', requireAuth, requireRole(UserRole.OWNER),
  validateBody(createPropertySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { name, addressLine1, addressLine2, city, state, postalCode, country } = req.body;

      const row = await queryOne(
        `INSERT INTO properties (organization_id, name, address_line1, address_line2, city, state, postal_code, country)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [user.orgId, name, addressLine1, addressLine2 || null, city, state, postalCode, country]
      );

      res.status(201).json({ data: row });
    } catch (err) { next(err); }
  }
);

// GET /:id - Get property
router.get('/:id', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `SELECT * FROM properties WHERE id = $1 AND organization_id = $2`,
        [req.params.id, user.orgId]
      );
      if (!row) throw new NotFoundError('Property not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  }
);

// PUT /:id - Update property
router.put('/:id', requireAuth, requireRole(UserRole.OWNER),
  validateBody(updatePropertySchema),
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
        const existing = await queryOne(`SELECT * FROM properties WHERE id = $1 AND organization_id = $2`, [req.params.id, user.orgId]);
        if (!existing) throw new NotFoundError('Property not found');
        return res.json({ data: existing });
      }

      sets.push(`updated_at = NOW()`);
      values.push(req.params.id, user.orgId);

      const row = await queryOne(
        `UPDATE properties SET ${sets.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
        values
      );
      if (!row) throw new NotFoundError('Property not found');
      res.json({ data: row });
    } catch (err) { next(err); }
  }
);

// DELETE /:id
router.delete('/:id', requireAuth, requireRole(UserRole.OWNER),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const row = await queryOne(
        `DELETE FROM properties WHERE id = $1 AND organization_id = $2 RETURNING id`,
        [req.params.id, user.orgId]
      );
      if (!row) throw new NotFoundError('Property not found');
      res.status(204).send();
    } catch (err) { next(err); }
  }
);

export { router as propertiesRouter };
