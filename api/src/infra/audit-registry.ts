import { db } from './db';

export const AUDIT_ACTIONS: string[] = [
  'create', 'update', 'delete', 'soft_delete', 'append',
  'apply_promotion', 'revoke_promotion', 'assign', 'cancel',
  'change_role', 'grant', 'invite', 'reinvite', 'remove',
  'revoke', 'revoke_invite', 'link', 'status_change',
];

interface SimpleEntity {
  kind: 'simple';
  label: string;
  table: string;
  nameColumn: string;
  /** Set when the table uses a non-integer PK (e.g. char(36) gym_id). */
  pkColumn?: string;
}

interface ComposedEntity {
  kind: 'composed';
  label: string;
  resolve: (entityId: string, gymId: string) => Promise<string | null>;
}

interface UnresolvableEntity {
  kind: 'none';
  label: string;
}

type EntityMeta = SimpleEntity | ComposedEntity | UnresolvableEntity;

export const AUDIT_ENTITY_REGISTRY: Record<string, EntityMeta> = {
  gym:                            { kind: 'simple',   label: 'Gyms',                     table: 'gyms',                    nameColumn: 'name', pkColumn: 'id' },
  member:                         { kind: 'simple',   label: 'Members',                  table: 'members',                 nameColumn: 'name' },
  gym_user:                       { kind: 'simple',   label: 'Users',                    table: 'gym_memberships',         nameColumn: 'name' },
  membership_plan:                { kind: 'simple',   label: 'Membership Plans',         table: 'membership_plans',        nameColumn: 'name' },
  training_plan:                  { kind: 'simple',   label: 'Training Plans',           table: 'training_plans',          nameColumn: 'name' },
  training_plan_template:         { kind: 'simple',   label: 'Training Plan Templates',  table: 'training_plan_templates', nameColumn: 'name' },
  workout_template:               { kind: 'simple',   label: 'Workout Templates',        table: 'workout_templates',       nameColumn: 'name' },
  workout:                        { kind: 'simple',   label: 'Workouts',                 table: 'workouts',                nameColumn: 'name' },
  exercise:                       { kind: 'simple',   label: 'Exercises',                table: 'exercises',               nameColumn: 'name' },
  class_type:                     { kind: 'simple',   label: 'Class Types',              table: 'class_types',             nameColumn: 'name' },
  promotion:                      { kind: 'simple',   label: 'Promotions',               table: 'promotions',              nameColumn: 'name' },
  event:                          { kind: 'simple',   label: 'Events',                   table: 'events',                  nameColumn: 'name' },
  center:                         { kind: 'simple',   label: 'Centers',                  table: 'centers',                 nameColumn: 'name' },
  space:                          { kind: 'simple',   label: 'Spaces',                   table: 'spaces',                  nameColumn: 'name' },

  user_membership: {
    kind: 'composed', label: 'Memberships',
    resolve: async (id) => {
      const { rows } = await db.query<{ member_name: string; plan_name: string }>(
        `SELECT m.name AS member_name, mp.name AS plan_name
         FROM user_memberships um
         JOIN members m ON m.id = um.member_id
         LEFT JOIN membership_plans mp ON mp.id = um.membership_plan_id
         WHERE um.id = ?`,
        [id],
      );
      if (!rows[0]) return null;
      return rows[0].plan_name
        ? `${rows[0].member_name} — ${rows[0].plan_name}`
        : rows[0].member_name;
    },
  },

  class_session: {
    kind: 'composed', label: 'Class Sessions',
    resolve: async (id) => {
      const { rows } = await db.query<{ class_type_name: string; starts_at: string }>(
        `SELECT ct.name AS class_type_name, cs.starts_at
         FROM class_sessions cs
         JOIN class_types ct ON ct.id = cs.class_type_id
         WHERE cs.id = ?`,
        [id],
      );
      if (!rows[0]) return null;
      const date = String(rows[0].starts_at).slice(0, 16).replace('T', ' ');
      return `${rows[0].class_type_name} ${date}`;
    },
  },

  billing_event: {
    kind: 'composed', label: 'Billing Events',
    resolve: async (id) => {
      const { rows } = await db.query<{ member_name: string; event_type: string }>(
        `SELECT m.name AS member_name, be.event_type
         FROM billing_events be
         LEFT JOIN members m ON m.id = be.member_id
         WHERE be.id = ?`,
        [id],
      );
      if (!rows[0]) return null;
      return rows[0].member_name
        ? `${rows[0].member_name} — ${rows[0].event_type}`
        : rows[0].event_type;
    },
  },

  member_training_plan: {
    kind: 'composed', label: 'Plan Assignments',
    resolve: async (id) => {
      const { rows } = await db.query<{ member_name: string; plan_name: string }>(
        `SELECT m.name AS member_name, tp.name AS plan_name
         FROM member_training_plans mtp
         JOIN members m ON m.id = mtp.member_id
         JOIN training_plans tp ON tp.id = mtp.training_plan_id
         WHERE mtp.id = ?`,
        [id],
      );
      if (!rows[0]) return null;
      return `${rows[0].member_name} — ${rows[0].plan_name}`;
    },
  },

  user_class_package: {
    kind: 'composed', label: 'Class Packages',
    resolve: async (id) => {
      const { rows } = await db.query<{ member_name: string; package_name: string }>(
        `SELECT m.name AS member_name, cp.name AS package_name
         FROM user_class_packages ucp
         JOIN members m ON m.id = ucp.member_id
         JOIN class_packages cp ON cp.id = ucp.class_package_id
         WHERE ucp.id = ?`,
        [id],
      );
      if (!rows[0]) return null;
      return `${rows[0].member_name} — ${rows[0].package_name}`;
    },
  },

  member_centers: {
    kind: 'composed', label: 'Member Centers',
    resolve: async (_id, gymId) => {
      // member_centers has no single PK; entity_id carries member_id in practice
      const { rows } = await db.query<{ member_name: string; center_name: string }>(
        `SELECT m.name AS member_name, c.name AS center_name
         FROM member_centers mc
         JOIN members m ON m.id = mc.member_id
         JOIN centers c ON c.id = mc.center_id
         WHERE mc.gym_id = ? AND mc.member_id = ?
         LIMIT 1`,
        [gymId, _id],
      );
      if (!rows[0]) return null;
      return `${rows[0].member_name} — ${rows[0].center_name}`;
    },
  },

  training_plan_template_workout: {
    kind: 'composed', label: 'Template Workouts',
    resolve: async (id) => {
      const { rows } = await db.query<{ template_name: string; workout_name: string }>(
        `SELECT tpt.name AS template_name, wt.name AS workout_name
         FROM training_plan_template_workouts tptw
         JOIN training_plan_templates tpt ON tpt.id = tptw.training_plan_template_id
         JOIN workout_templates wt ON wt.id = tptw.workout_template_id
         WHERE tptw.id = ?`,
        [id],
      );
      if (!rows[0]) return null;
      return `${rows[0].template_name} — ${rows[0].workout_name}`;
    },
  },

  trainer_availability: { kind: 'none', label: 'Trainer Availability' },
  workout_template_block: { kind: 'none', label: 'Workout Template Blocks' },
  workout_template_exercise: { kind: 'none', label: 'Workout Template Exercises' },
  workout_block: { kind: 'none', label: 'Workout Blocks' },
  workout_exercise: { kind: 'none', label: 'Workout Exercises' },
  superadmin: { kind: 'none', label: 'Superadmins' },
};

export async function resolveEntityName(
  entityType: string,
  entityId: string | null,
  gymId: string,
): Promise<string | null> {
  if (!entityId) return null;
  const meta = AUDIT_ENTITY_REGISTRY[entityType];
  if (!meta || meta.kind === 'none') return null;

  try {
    if (meta.kind === 'simple') {
      const pkCol = meta.pkColumn ?? 'id';
      const { rows } = await db.query<Record<string, unknown>>(
        `SELECT ${meta.nameColumn} FROM ${meta.table} WHERE ${pkCol} = ?`,
        [entityId],
      );
      return (rows[0]?.[meta.nameColumn] as string) ?? null;
    }
    return await meta.resolve(entityId, gymId);
  } catch {
    return null;
  }
}

/** FK columns whose values can be enriched with a resolved name. */
const FK_MAP: Record<string, { table: string; nameColumn: string }> = {
  gym_id:                     { table: 'gyms',                    nameColumn: 'name' },
  member_id:                  { table: 'members',                 nameColumn: 'name' },
  membership_plan_id:         { table: 'membership_plans',        nameColumn: 'name' },
  training_plan_id:           { table: 'training_plans',          nameColumn: 'name' },
  training_plan_template_id:  { table: 'training_plan_templates', nameColumn: 'name' },
  workout_template_id:        { table: 'workout_templates',       nameColumn: 'name' },
  class_type_id:              { table: 'class_types',             nameColumn: 'name' },
  exercise_id:                { table: 'exercises',               nameColumn: 'name' },
  center_id:                  { table: 'centers',                 nameColumn: 'name' },
  space_id:                   { table: 'spaces',                  nameColumn: 'name' },
  promotion_id:               { table: 'promotions',              nameColumn: 'name' },
};

/**
 * Enrich a raw DB-row payload: replace `foo_id: value` with
 * `foo: { id: value, name: "<resolved>" }` for known FK columns.
 * Unknown columns are passed through unchanged.
 */
export async function enrichPayload(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const fkJobs: Array<{ col: string; id: unknown; table: string; nameColumn: string }> = [];

  for (const [key, value] of Object.entries(payload)) {
    const fk = FK_MAP[key];
    if (fk && value != null) {
      fkJobs.push({ col: key.slice(0, -3), id: value, ...fk }); // strip trailing "_id"
    } else {
      result[key] = value;
    }
  }

  await Promise.all(
    fkJobs.map(async ({ col, id, table, nameColumn }) => {
      try {
        const { rows } = await db.query<Record<string, unknown>>(
          `SELECT ${nameColumn} FROM ${table} WHERE id = ?`,
          [id],
        );
        result[col] = { id, name: (rows[0]?.[nameColumn] as string) ?? null };
      } catch {
        result[`${col}_id`] = id;
      }
    }),
  );

  return result;
}
