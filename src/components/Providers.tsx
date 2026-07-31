"use client";

import { SessionProvider } from "next-auth/react";
import { PushRegistration } from "@/components/PushRegistration";
import { NativeGoogleSignIn } from "@/components/NativeGoogleSignIn";
import { NativeAppleSignIn } from "@/components/NativeAppleSignIn";

// Client boundary that exposes the Auth.js session to `useSession()` throughout the app.
// PushRegistration bridges the native iOS shell's APNs token to /api/push/register; NativeGoogleSignIn
// and NativeAppleSignIn bridge the native Google / Apple sign-in tokens into an Auth.js session. All
// live inside the provider so they can react to / drive the session.
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {children}
      <PushRegistration />
      <NativeGoogleSignIn />
      <NativeAppleSignIn />
    </SessionProvider>
  );
}
