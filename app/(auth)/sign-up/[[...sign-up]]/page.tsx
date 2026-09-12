import { SignUp } from '@clerk/nextjs';

import { authAppearance } from '@/lib/clerk-appearance';

export default function SignUpPage() {
  return <SignUp appearance={authAppearance} />;
}
