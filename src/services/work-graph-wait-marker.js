// Only an explicitly requested child wait may set this durable pause reason.
// Older paused records with a free-form reason cannot prove auto-resume intent.
export const AUTO_RESUME_ON_CHILD_DELIVERY = "waiting_for_children:auto_resume";

export function isAutomaticChildWait(item) {
  return item?.status === "paused" && item.statusReason === AUTO_RESUME_ON_CHILD_DELIVERY;
}
