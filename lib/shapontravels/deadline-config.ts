export function shaponDeadlineEnabled(flag: string | undefined, vercelEnvironment: string | undefined): boolean {
  return flag === 'true' || (flag === undefined && vercelEnvironment === 'production');
}

export function shaponLiveDeadlineRefreshEnabled(): boolean {
  return shaponDeadlineEnabled(process.env.SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED, process.env.VERCEL_ENV);
}
