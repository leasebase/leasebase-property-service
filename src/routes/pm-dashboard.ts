import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  requireAuth, requireRole,
  query,
  type AuthenticatedRequest, UserRole,
} from '@leasebase/service-common';

const router = Router();

/**
 * GET /dashboard
 *
 * Aggregate PM dashboard endpoint. Returns all data needed by the frontend
 * PM dashboard in a single response.
 *
 * Scope resolution (server-side, never trusts client parameters):
 * - ORG_ADMIN: sees all properties in their organization.
 * - PM_STAFF: sees only properties assigned via manager_property_assignments.
 *
 * Returns a valid empty payload when the PM has no assigned properties.
 */
router.get('/dashboard', requireAuth, requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const orgId = user.orgId;
      const userId = user.userId;
      const isAdmin = user.role === UserRole.ORG_ADMIN;

      // ── Step 1: Resolve assigned property IDs ──
      let propertyIds: string[];

      if (isAdmin) {
        // ORG_ADMIN sees all org properties
        const rows = await query<{ id: string }>(
          `SELECT id FROM properties WHERE organization_id = $1`,
          [orgId],
        );
        propertyIds = rows.map((r) => r.id);
      } else {
        // PM_STAFF sees only assigned properties
        const rows = await query<{ property_id: string }>(
          `SELECT property_id FROM manager_property_assignments
           WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
          [orgId, userId],
        );
        propertyIds = rows.map((r) => r.property_id);
      }

      // ── Empty state: no assigned properties ──
      if (propertyIds.length === 0) {
        return res.json(emptyDashboard());
      }

      // ── Step 2: Fetch all domain data scoped to assigned properties ──
      const placeholders = propertyIds.map((_, i) => `$${i + 2}`).join(', ');
      const baseParams = [orgId, ...propertyIds];

      const [
        properties,
        units,
        leases,
        tenants,
        workOrders,
        payments,
        ledgerEntries,
      ] = await Promise.all([
        // Properties
        query(
          `SELECT id, name, address_line1, address_line2, city, state, postal_code, country, status, created_at, updated_at
           FROM properties
           WHERE organization_id = $1 AND id IN (${placeholders})
           ORDER BY name ASC`,
          baseParams,
        ),
        // Units for those properties
        query(
          `SELECT id, property_id, unit_number, bedrooms, bathrooms, square_feet, rent_amount, status
           FROM units
           WHERE organization_id = $1 AND property_id IN (${placeholders})`,
          baseParams,
        ),
        // Leases for units in those properties
        query(
          `SELECT l.id, l.unit_id, l.start_date, l.end_date, l.rent_amount, l.deposit_amount, l.status
           FROM leases l
           JOIN units u ON u.id = l.unit_id
           WHERE l.organization_id = $1 AND u.property_id IN (${placeholders})`,
          baseParams,
        ),
        // Tenants linked to leases in those properties
        query(
          `SELECT tp.id, tp.user_id, tp.lease_id, usr.name, usr.email, tp.phone
           FROM tenant_profiles tp
           JOIN users usr ON usr.id = tp.user_id
           JOIN leases l ON l.id = tp.lease_id
           JOIN units u ON u.id = l.unit_id
           WHERE l.organization_id = $1 AND u.property_id IN (${placeholders})`,
          baseParams,
        ),
        // Work orders for units in those properties (recent 20)
        query(
          `SELECT wo.id, wo.unit_id, wo.category, wo.priority, wo.status,
                  wo.description, wo.assignee_id, wo.tenant_user_id,
                  wo.created_at, wo.updated_at
           FROM work_orders wo
           JOIN units u ON u.id = wo.unit_id
           WHERE wo.organization_id = $1 AND u.property_id IN (${placeholders})
           ORDER BY wo.created_at DESC
           LIMIT 20`,
          baseParams,
        ),
        // Payments for leases in those properties (recent 20)
        query(
          `SELECT p.id, p.lease_id, p.amount, p.currency, p.method, p.status, p.created_at
           FROM payments p
           JOIN leases l ON l.id = p.lease_id
           JOIN units u ON u.id = l.unit_id
           WHERE p.organization_id = $1 AND u.property_id IN (${placeholders})
           ORDER BY p.created_at DESC
           LIMIT 20`,
          baseParams,
        ),
        // Ledger entries for overdue calculation
        query(
          `SELECT le.id, le.type, le.amount, le.status, le.due_date
           FROM ledger_entries le
           JOIN leases l ON l.id = le.lease_id
           JOIN units u ON u.id = l.unit_id
           WHERE le.organization_id = $1 AND u.property_id IN (${placeholders})
             AND le.type = 'CHARGE' AND le.status = 'PENDING'`,
          baseParams,
        ),
      ]);

      // ── Step 3: Compute KPIs ──
      const totalProperties = properties.length;
      const totalUnits = units.length;

      const activeLeaseUnitIds = new Set(
        leases.filter((l: any) => l.status === 'ACTIVE').map((l: any) => l.unit_id),
      );
      const occupiedUnits = units.filter((u: any) => activeLeaseUnitIds.has(u.id)).length;
      const vacancyRate = totalUnits > 0
        ? Math.round(((totalUnits - occupiedUnits) / totalUnits) * 10000) / 100
        : 0;

      const monthlyScheduledRent = leases
        .filter((l: any) => l.status === 'ACTIVE')
        .reduce((sum: number, l: any) => sum + (l.rent_amount || 0), 0);

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const collectedThisMonth = payments
        .filter((p: any) => p.status === 'SUCCEEDED' && p.created_at >= monthStart)
        .reduce((sum: number, p: any) => sum + (p.amount || 0), 0);

      const today = new Date().toISOString().split('T')[0];
      const overdueAmount = ledgerEntries
        .filter((e: any) => e.due_date < today)
        .reduce((sum: number, e: any) => sum + (e.amount || 0), 0);

      const openMaintenanceRequests = workOrders.filter(
        (w: any) => w.status === 'OPEN' || w.status === 'IN_PROGRESS',
      ).length;

      // ── Step 4: Build tasks (derived from data) ──
      const tasks = buildTasks(leases, ledgerEntries, workOrders);

      // ── Step 5: Respond ──
      res.json({
        kpis: {
          totalProperties,
          totalUnits,
          occupiedUnits,
          vacancyRate,
          monthlyScheduledRent,
          collectedThisMonth,
          overdueAmount,
          openMaintenanceRequests,
        },
        properties,
        units,
        leases,
        tenants,
        maintenanceRequests: workOrders,
        recentPayments: payments,
        tasks,
      });
    } catch (err) {
      next(err);
    }
  },
);

/* ─── Helpers ─── */

function emptyDashboard() {
  return {
    kpis: {
      totalProperties: 0,
      totalUnits: 0,
      occupiedUnits: 0,
      vacancyRate: 0,
      monthlyScheduledRent: 0,
      collectedThisMonth: 0,
      overdueAmount: 0,
      openMaintenanceRequests: 0,
    },
    properties: [],
    units: [],
    leases: [],
    tenants: [],
    maintenanceRequests: [],
    recentPayments: [],
    tasks: [],
  };
}

function buildTasks(leases: any[], ledgerEntries: any[], workOrders: any[]): any[] {
  const tasks: any[] = [];
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  let taskId = 0;

  // Leases expiring within 60 days
  const sixtyDaysOut = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  for (const l of leases) {
    if (l.status === 'ACTIVE' && l.end_date >= todayStr && l.end_date <= sixtyDaysOut) {
      const endDate = typeof l.end_date === 'string' ? l.end_date : l.end_date.toISOString().split('T')[0];
      tasks.push({
        id: `task-lease-${++taskId}`,
        type: 'lease_renewal',
        title: `Lease renewal due — ${l.id}`,
        severity: endDate <= todayStr ? 'danger' : 'warning',
        link: '/app/leases',
        due_date: endDate,
        created_at: today.toISOString(),
      });
    }
  }

  // Overdue payments
  for (const e of ledgerEntries) {
    if (e.due_date < todayStr) {
      tasks.push({
        id: `task-payment-${++taskId}`,
        type: 'payment_overdue',
        title: `Overdue charge — ${e.id}`,
        severity: 'danger',
        link: '/app/payments',
        due_date: typeof e.due_date === 'string' ? e.due_date : e.due_date.toISOString().split('T')[0],
        created_at: today.toISOString(),
      });
    }
  }

  // Open work orders older than 7 days
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  for (const w of workOrders) {
    if ((w.status === 'OPEN' || w.status === 'IN_PROGRESS') && w.created_at < sevenDaysAgo) {
      tasks.push({
        id: `task-maint-${++taskId}`,
        type: 'maintenance',
        title: `Aging work order — ${w.description?.slice(0, 50) || w.id}`,
        severity: 'warning',
        link: '/app/maintenance',
        created_at: w.created_at,
      });
    }
  }

  return tasks;
}

export { router as pmDashboardRouter };
