import 'server-only';

const DASHBOARD_FEATURE_ENV = {
  'system-reports': 'SUPERADMIN_SYSTEM_REPORTS_ENABLED',
  'search-control': 'SUPERADMIN_SEARCH_CONTROL_ENABLED',
} as const;

type DashboardFeature = keyof typeof DASHBOARD_FEATURE_ENV;

/** Optional admin pages are disabled until explicitly enabled on the server. */
export function dashboardFeatureEnabled(feature: DashboardFeature): boolean {
  return process.env[DASHBOARD_FEATURE_ENV[feature]]?.trim() === 'true';
}

export function hiddenDashboardSegments(): string[] {
  return (Object.keys(DASHBOARD_FEATURE_ENV) as DashboardFeature[]).filter(
    (feature) => !dashboardFeatureEnabled(feature),
  );
}
