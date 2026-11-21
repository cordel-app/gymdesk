// #3090 stage 4 (§5): the weekly-allowance warning of the Professional Services
// Schedule. The API says how many sessions per week the member's plans include
// for each Professional Service (`included_per_week`, null when there is no
// weekly allowance to compare against); this only counts the selected weekly
// slots per service and reports the services that exceed it. A warning, never a
// block. Pure: no React, no `t()`.

export interface AllowanceService {
  professional_service_id: number;
  name: string;
  included_per_week: number | null;
}

export interface OverAllowance {
  professional_service_id: number;
  name: string;
  scheduled: number;
  included: number;
}

export function overWeeklyAllowance(
  selectedSlots: Array<{ professional_service_id: number }>,
  services: AllowanceService[],
): OverAllowance[] {
  const out: OverAllowance[] = [];
  for (const s of services) {
    if (s.included_per_week == null) continue;
    const scheduled = selectedSlots.filter((p) => p.professional_service_id === s.professional_service_id).length;
    if (scheduled > s.included_per_week) {
      out.push({ professional_service_id: s.professional_service_id, name: s.name, scheduled, included: s.included_per_week });
    }
  }
  return out;
}
