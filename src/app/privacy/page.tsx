import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Thesis",
  description: "How Thesis collects, uses, and protects your data.",
};

// Public (no auth) privacy policy. Its URL — https://thesis-ios.vercel.app/privacy — is submitted to
// App Store Connect. Plain-language; reflects the app's actual data flows (Auth.js Google/Apple sign-in,
// Turso storage, APNs push, third-party market/news/AI providers). Self-contained dark styling so it
// reads correctly both in a browser and inside the iOS WKWebView.
export default function PrivacyPolicy() {
  return (
    <main className="min-h-screen bg-black px-6 py-[max(2rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] text-[15px] leading-relaxed text-zinc-300 font-sans">
      <div className="mx-auto w-full max-w-[680px]">
        <Link href="/" className="text-[13px] text-zinc-500 transition-colors hover:text-zinc-300">
          ← Back to Thesis
        </Link>

        <h1 className="mt-6 text-[26px] font-semibold text-white">Privacy Policy</h1>
        <p className="mt-1 text-[13px] text-zinc-500">Last updated: July 31, 2026</p>

        <p className="mt-6">
          Thesis (&ldquo;Thesis,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) is a personal prediction-market and
          portfolio dashboard. This policy explains what we collect, how we use it, who we share it with, and the
          choices you have — including deleting your account and all of your data from inside the app.
        </p>

        <Section title="Information we collect">
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>
              <b className="text-zinc-200">Account information.</b> When you sign in with Google or Apple, we receive
              your name and email address. If you use Sign in with Apple and choose to hide your email, we receive
              Apple&rsquo;s private-relay address instead. We do not receive or store your Google/Apple password.
            </li>
            <li>
              <b className="text-zinc-200">Portfolio data.</b> The holdings you add — ticker symbols, position weights,
              and any thesis notes you write.
            </li>
            <li>
              <b className="text-zinc-200">Device push token.</b> If you allow notifications, we store your device&rsquo;s
              Apple Push Notification token so we can tell you when your daily brief is ready.
            </li>
            <li>
              <b className="text-zinc-200">Usage information.</b> Basic activity needed to operate and improve the app —
              sign-in events, timestamps, device make/model, and performance/latency metrics.
            </li>
          </ul>
        </Section>

        <Section title="How we use your information">
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>Build and display your portfolio dashboard and its related markets and news.</li>
            <li>Generate your daily brief and analyst-sentiment insights from your holdings.</li>
            <li>Send the &ldquo;your brief is ready&rdquo; push notification, if you enable notifications.</li>
            <li>Operate, secure, debug, and improve the service.</li>
          </ul>
        </Section>

        <Section title="How your information is shared">
          <p className="mt-2">
            We do <b className="text-zinc-200">not</b> sell your personal information. We share it only with the service
            providers that make the app work:
          </p>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>
              <b className="text-zinc-200">Sign-in:</b> Google and Apple, to authenticate you.
            </li>
            <li>
              <b className="text-zinc-200">Hosting &amp; storage:</b> Vercel (app hosting) and Turso (database) store your
              account and portfolio data.
            </li>
            <li>
              <b className="text-zinc-200">Notifications:</b> Apple Push Notification service (APNs) delivers your brief
              notification.
            </li>
            <li>
              <b className="text-zinc-200">Market, news &amp; AI providers:</b> to produce your brief and insights we send
              your holdings&rsquo; ticker symbols (not your identity) to prediction-market, news, price, and AI-analysis
              providers. These are used to generate research and are not used to identify you.
            </li>
          </ul>
          <p className="mt-2">We may also disclose information if required by law or to protect the service and its users.</p>
        </Section>

        <Section title="Data retention &amp; deletion">
          <p className="mt-2">
            We keep your data while your account is active. You can delete your account and all associated data at any
            time from <b className="text-zinc-200">Account → Delete Account</b> in the app. Deletion is immediate and
            permanent: it removes your holdings, portfolio briefs, push tokens, account record, and activity logs. It
            cannot be undone. You may also request deletion by emailing us at the address below.
          </p>
        </Section>

        <Section title="Security">
          <p className="mt-2">
            Data is transmitted over encrypted connections and stored with our hosting and database providers. No method
            of transmission or storage is perfectly secure, but we take reasonable measures to protect your information.
          </p>
        </Section>

        <Section title="Children">
          <p className="mt-2">Thesis is not directed to children under 13, and we do not knowingly collect their data.</p>
        </Section>

        <Section title="Changes to this policy">
          <p className="mt-2">
            We may update this policy from time to time. Material changes will be reflected by the &ldquo;last
            updated&rdquo; date above.
          </p>
        </Section>

        <Section title="Contact">
          <p className="mt-2">
            Questions or deletion requests:{" "}
            <a href="mailto:info@betathesis.com" className="text-zinc-100 underline underline-offset-2">
              info@betathesis.com
            </a>
            .
          </p>
        </Section>

        <p className="mt-10 border-t border-white/10 pt-6 text-[13px] text-zinc-500">
          Thesis is for informational purposes only and is not investment, financial, or trading advice.
          Prediction-market data is informational; Thesis is not a broker-dealer and does not execute trades or bets.
        </p>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-[17px] font-semibold text-white">{title}</h2>
      {children}
    </section>
  );
}
