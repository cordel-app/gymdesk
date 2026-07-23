export type AppRole =
  | 'admin'
  | 'trainer_performance'
  | 'trainer_perf_nutrition'
  | 'front_desk'
  | 'accountant'
  | 'nutritionist'
  | 'member';

export type AppModule =
  | 'MEMBERS'
  | 'ORGANIZATION'
  | 'TRAINING'
  | 'NUTRITION'
  | 'FINANCIALS'
  | 'PAYMENTS'
  | 'SYSTEM'
  | 'CORDEL';

export type PermissionLevel = 'RW' | 'R' | 'R_ASSIGNED' | 'RW_ASSIGNED' | 'R_OWN' | 'NONE';

export const PERMISSION_MATRIX: Record<AppModule, Record<AppRole, PermissionLevel>> = {
  MEMBERS:      { admin: 'RW', trainer_performance: 'R_ASSIGNED', trainer_perf_nutrition: 'R_ASSIGNED', front_desk: 'RW',   accountant: 'R',    nutritionist: 'R_ASSIGNED', member: 'R_OWN' },
  ORGANIZATION: { admin: 'RW', trainer_performance: 'NONE',       trainer_perf_nutrition: 'NONE',       front_desk: 'R',    accountant: 'NONE', nutritionist: 'NONE',       member: 'NONE'  },
  TRAINING:     { admin: 'RW', trainer_performance: 'RW_ASSIGNED',trainer_perf_nutrition: 'RW_ASSIGNED',front_desk: 'R',    accountant: 'NONE', nutritionist: 'NONE',       member: 'R_OWN' },
  NUTRITION:    { admin: 'RW', trainer_performance: 'R',          trainer_perf_nutrition: 'RW_ASSIGNED',front_desk: 'R',    accountant: 'NONE', nutritionist: 'RW_ASSIGNED', member: 'R_OWN' },
  FINANCIALS:   { admin: 'RW', trainer_performance: 'NONE',       trainer_perf_nutrition: 'NONE',       front_desk: 'NONE', accountant: 'RW',   nutritionist: 'NONE',       member: 'NONE'  },
  PAYMENTS:     { admin: 'RW', trainer_performance: 'NONE',       trainer_perf_nutrition: 'NONE',       front_desk: 'RW',   accountant: 'RW',   nutritionist: 'NONE',       member: 'NONE'  },
  SYSTEM:       { admin: 'RW', trainer_performance: 'NONE',       trainer_perf_nutrition: 'NONE',       front_desk: 'NONE', accountant: 'NONE', nutritionist: 'NONE',       member: 'NONE'  },
  CORDEL:       { admin: 'NONE',trainer_performance: 'NONE',      trainer_perf_nutrition: 'NONE',       front_desk: 'NONE', accountant: 'NONE', nutritionist: 'NONE',       member: 'NONE'  },
};

export function canAccessModule(role: AppRole, module: AppModule): boolean {
  const level = PERMISSION_MATRIX[module][role];
  return level !== 'NONE' && level !== 'R_OWN';
}

export function canWriteModule(role: AppRole, module: AppModule): boolean {
  const level = PERMISSION_MATRIX[module][role];
  return level === 'RW' || level === 'RW_ASSIGNED';
}

export const ASSIGNABLE_ROLES: AppRole[] = [
  'admin',
  'trainer_performance',
  'trainer_perf_nutrition',
  'front_desk',
  'accountant',
  'nutritionist',
];
