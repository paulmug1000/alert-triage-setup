// ============================================================================
// PULSE ECOSYSTEM UNIFIED VERSION
// Rule: Always increment this version by 0.01 whenever changes are made to the system.
// Referenced across Pulse Portal (profile menu) and Pulse Management Area (Settings).
// ============================================================================
export const SYSTEM_VERSION = "4.25";

export const getSystemCopyright = () => {
  return `© ${new Date().getFullYear()} Thrive Organisational Consulting Ltd`;
};
