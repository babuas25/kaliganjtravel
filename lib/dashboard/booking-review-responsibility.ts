export function bookingReviewResponsibility(team: string | null | undefined): string {
  switch (team?.trim().toLowerCase()) {
    case 'support':
      return 'Needs Support Review';
    case 'accounts':
      return 'Needs Accounts Review';
    case 'admin':
      return 'Needs Admin Review';
    default:
      return 'Needs Staff Review';
  }
}
