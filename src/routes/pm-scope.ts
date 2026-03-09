/**
 * PM Scope Helpers
 *
 * Reusable scope resolution for PM endpoints. All PM routes use these
 * helpers to enforce property-level authorization.
 *
 * Rules:
 * - PM_STAFF: sees only properties assigned via manager_property_assignments
 * - ORG_ADMIN: sees all properties in their organization
 * - Never trusts client-supplied scope hints
 */

import {
  requireAuth, requireRole,
  query, queryOne, NotFoundError,
  type AuthenticatedRequest, UserRole,
  type CurrentUser,
} from '@leasebase/service-common';

/** Role guard for all PM endpoints: ORG_ADMIN + PM_STAFF only. */
export const requirePMRole = requireRole(UserRole.ORG_ADMIN, UserRole.PM_STAFF);

/**
 * Resolve the set of property IDs this user can access.
 *
 * - ORG_ADMIN → all org properties
 * - PM_STAFF  → assigned properties (via manager_property_assignments)
 *
 * Returns empty array when no assignments exist (valid empty state).
 */
export async function resolvePMPropertyIds(user: CurrentUser): Promise<string[]> {
  if (user.role === UserRole.ORG_ADMIN) {
    const rows = await query<{ id: string }>(
      `SELECT id FROM properties WHERE organization_id = $1`,
      [user.orgId],
    );
    return rows.map((r) => r.id);
  }

  // PM_STAFF: scoped via manager_property_assignments
  const rows = await query<{ property_id: string }>(
    `SELECT property_id FROM manager_property_assignments
     WHERE organization_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
    [user.orgId, user.userId],
  );
  return rows.map((r) => r.property_id);
}

/**
 * Verify a single property ID is within the user's PM scope.
 * Throws NotFoundError if the property is outside scope (404, not 403 —
 * we don't reveal existence of unassigned resources).
 */
export async function requirePMPropertyAccess(
  propertyId: string,
  user: CurrentUser,
): Promise<void> {
  if (user.role === UserRole.ORG_ADMIN) {
    const row = await queryOne(
      `SELECT id FROM properties WHERE id = $1 AND organization_id = $2`,
      [propertyId, user.orgId],
    );
    if (!row) throw new NotFoundError('Property not found');
    return;
  }

  // PM_STAFF: must be assigned
  const row = await queryOne(
    `SELECT id FROM manager_property_assignments
     WHERE organization_id = $1 AND user_id = $2 AND property_id = $3 AND status = 'ACTIVE'`,
    [user.orgId, user.userId, propertyId],
  );
  if (!row) throw new NotFoundError('Property not found');
}

/**
 * Build SQL helpers for scoped queries.
 * Returns { placeholders, baseParams } for use in WHERE ... IN (...) clauses.
 * The first param ($1) is always orgId; subsequent params are property IDs.
 */
export function buildScopeParams(orgId: string, propertyIds: string[]) {
  const placeholders = propertyIds.map((_, i) => `$${i + 2}`).join(', ');
  const baseParams = [orgId, ...propertyIds];
  return { placeholders, baseParams };
}
