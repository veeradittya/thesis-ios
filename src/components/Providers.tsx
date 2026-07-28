"use client";

import { SessionProvider } from "next-auth/react";
import { PushRegistration } from "@/components/PushRegistration";

// Client boundary that exposes the Auth.js session to `useSession()` throughout the app.
// PushRegistration (inside the provider so it can react to sign-in) bridges the native iOS shell's
// APNs token to /api/push/register.
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {children}
      <PushRegistration />
    </SessionProvider>
  );
}
