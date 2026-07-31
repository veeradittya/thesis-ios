"use client";

import { SessionProvider } from "next-auth/react";
import { PushRegistration } from "@/components/PushRegistration";
import { NativeGoogleSignIn } from "@/components/NativeGoogleSignIn";

// Client boundary that exposes the Auth.js session to `useSession()` throughout the app.
// PushRegistration bridges the native iOS shell's APNs token to /api/push/register; NativeGoogleSignIn
// bridges the native Google Sign-In SDK's ID token into an Auth.js session. Both live inside the
// provider so they can react to / drive the session.
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {children}
      <PushRegistration />
      <NativeGoogleSignIn />
    </SessionProvider>
  );
}
