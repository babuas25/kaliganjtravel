import { SignIn } from '@clerk/nextjs';

import { authAppearance } from '@/lib/clerk-appearance';

export default function SignInPage() {
  return <SignIn appearance={authAppearance} />;
}
