// ============================================================================
// PULSE ECOSYSTEM UNIFIED VERSION
// Rule: Always increment this version by 0.001 whenever changes are made to the system.
// Referenced across Pulse Portal (profile menu) and Pulse Management Area (Settings).
// ============================================================================
export const SYSTEM_VERSION = "1.815";

export const getSystemCopyright = () => {
  return `© ${new Date().getFullYear()} Thrive Organisational Consulting Ltd`;
};
