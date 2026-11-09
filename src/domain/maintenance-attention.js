import { requiresBrainMaintenance } from "./brain-failure-recovery.js";
import { legacyMaintenanceAttentionCode } from "./legacy-brain-recovery.js";

// Recognize the system-generated retry request, including persisted requests
// from older versions. Business questions and missing configuration stay visible.
export function maintenanceAttentionCode(item) {
  const code = Object.hasOwn(item, "recoveryCode") ? item.recoveryCode : legacyMaintenanceAttentionCode(item);
  return requiresBrainMaintenance(code) ? code : null;
}
