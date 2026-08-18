"use client";

import { FormEvent, useRef, useState } from "react";
import { ArrowUpRight, Check, Mail, TrendingUp, Users, X } from "lucide-react";

type SubmitState = "idle" | "loading" | "success" | "error";

async function submitInterest(email: string, kind: "updates" | "beta", name = "", company = "") {
  const response = await fetch("/api/interest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, kind, name, company }),
  });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error || "Something went wrong.");
}

export function LandingPage() {
  const [email, setEmail] = useState("");
  const [updatesState, setUpdatesState] = useState<SubmitState>("idle");
  const [updatesError, setUpdatesError] = useState("");
  const [betaOpen, setBetaOpen] = useState(false);
  const [betaState, setBetaState] = useState<SubmitState>("idle");
  const [betaError, setBetaError] = useState("");
  const betaEmail = useRef<HTMLInputElement>(null);

  async function submitUpdates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUpdatesState("loading");
    setUpdatesError("");
    try {
      await submitInterest(email, "updates", "", String(new FormData(event.currentTarget).get("company") || ""));
      setUpdatesState("success");
    } catch (error) {
      setUpdatesState("error");
      setUpdatesError(error instanceof Error ? error.message : "Please try again.");
    }
  }

  async function submitBeta(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBetaState("loading");
    setBetaError("");
    const data = new FormData(event.currentTarget);
    try {
      await submitInterest(String(data.get("email") || ""), "beta", String(data.get("name") || ""), String(data.get("company") || ""));
      setBetaState("success");
    } catch (error) {
      setBetaState("error");
      setBetaError(error instanceof Error ? error.message : "Please try again.");
    }
  }

  function openBeta() {
    setBetaOpen(true);
    requestAnimationFrame(() => betaEmail.current?.focus());
  }

  return (
    <main className="relative min-h-dvh overflow-hidden bg-[#040b18] text-[#f4f0e6] selection:bg-[#b7d58e]/30">
      <div className="pointer-events-none absolute inset-0 opacity-70" aria-hidden="true">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_28%,rgba(186,157,111,0.15),transparent_31%),radial-gradient(circle_at_82%_58%,rgba(113,145,114,0.09),transparent_30%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:128px_128px]" />
      </div>

      <header className="relative z-10 flex h-20 items-center justify-between border-b border-white/10 px-6 sm:px-10 lg:px-16">
        <span className="font-serif text-3xl tracking-[-0.03em]">Thesis</span>
        <span className="flex items-center gap-3 text-xs font-medium tracking-[0.2em] text-[#b7d58e] sm:text-sm">
          <span className="h-2.5 w-2.5 rounded-full bg-[#b7d58e] shadow-[0_0_16px_rgba(183,213,142,0.45)]" />
          COMING SOON
        </span>
      </header>

      <section className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center px-5 pb-16 pt-16 text-center sm:px-8 sm:pt-20 lg:pt-24">
        <p className="mb-7 text-[11px] font-semibold tracking-[0.3em] text-[#b7d58e] sm:text-sm">A NEW KIND OF WEALTH PLATFORM</p>
        <h1 className="max-w-5xl text-balance font-serif text-[clamp(3rem,7.2vw,6.5rem)] leading-[0.94] tracking-[-0.045em]">
          Wealth management for the everyday Joe and Jane.
        </h1>
        <p className="mt-8 text-lg text-white/70 sm:text-2xl">Guidance designed for your life.</p>

        <form onSubmit={submitUpdates} className="mt-10 w-full max-w-3xl text-left sm:mt-12">
          <div className="flex flex-col overflow-hidden rounded-2xl border border-[#bca574]/60 bg-[#07101e]/90 shadow-2xl shadow-black/25 sm:flex-row">
            <label className="flex min-h-20 flex-1 items-center gap-4 px-6">
              <Mail className="h-6 w-6 shrink-0 text-[#c6b58f]" strokeWidth={1.5} />
              <span className="sr-only">Email address</span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Enter your email"
                className="min-w-0 flex-1 bg-transparent text-lg text-white outline-none placeholder:text-white/48"
              />
            </label>
            <input name="company" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
            <button
              type="submit"
              disabled={updatesState === "loading" || updatesState === "success"}
              className="min-h-20 bg-[#b7d58e] px-9 text-lg font-semibold text-[#07101e] transition hover:bg-[#c8e49f] disabled:cursor-default disabled:opacity-80 sm:min-w-64"
            >
              {updatesState === "success" ? <span className="flex items-center justify-center gap-2"><Check className="h-5 w-5" /> You’re on the list</span> : updatesState === "loading" ? "Signing up…" : "Sign up for updates"}
            </button>
          </div>
          {updatesError && <p className="mt-3 text-sm text-red-300">{updatesError}</p>}
        </form>

        <div className="mt-8 grid w-full max-w-5xl overflow-hidden rounded-2xl border border-[#bca574]/55 bg-[linear-gradient(110deg,rgba(10,21,36,0.96),rgba(27,26,27,0.93))] text-left shadow-2xl shadow-black/20 md:grid-cols-2">
          <div className="flex items-center gap-6 border-b border-white/10 p-7 sm:p-9 md:border-b-0 md:border-r">
            <span className="grid h-16 w-16 shrink-0 place-items-center rounded-full border border-[#b7d58e]/60 text-[#b7d58e]"><Users className="h-7 w-7" strokeWidth={1.5} /></span>
            <div>
              <p className="text-xs font-semibold tracking-[0.23em] text-[#b7d58e]">APPLY FOR BETA TESTING</p>
              <h2 className="mt-3 font-serif text-3xl sm:text-4xl">Help shape Thesis.</h2>
            </div>
          </div>
          <div className="p-7 sm:p-9">
            <div className="flex items-start gap-5">
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full border border-[#d2a85f]/55 text-[#e0b45f]"><TrendingUp className="h-6 w-6" strokeWidth={1.5} /></span>
              <p className="text-lg leading-relaxed text-white/80">Previous beta cohort earned a <strong className="font-semibold text-[#e4b562]">3.59 increase</strong> in their portfolio.<sup>*</sup></p>
            </div>
            <button onClick={openBeta} className="mt-6 flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border border-[#b7d58e] text-base font-medium text-[#b7d58e] transition hover:bg-[#b7d58e] hover:text-[#07101e]">
              Apply for beta access <ArrowUpRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </section>

      <footer className="relative z-10 border-t border-white/10 px-6 py-8 text-center text-sm text-white/35">© 2026 Thesis</footer>

      {betaOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && setBetaOpen(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="beta-title" className="relative w-full max-w-lg rounded-2xl border border-[#bca574]/50 bg-[#081321] p-7 shadow-2xl sm:p-9">
            <button onClick={() => setBetaOpen(false)} aria-label="Close" className="absolute right-5 top-5 rounded-full p-2 text-white/50 hover:bg-white/10 hover:text-white"><X className="h-5 w-5" /></button>
            {betaState === "success" ? (
              <div className="py-8 text-center">
                <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#b7d58e] text-[#07101e]"><Check className="h-7 w-7" /></span>
                <h2 id="beta-title" className="mt-6 font-serif text-4xl">Application received.</h2>
                <p className="mt-3 text-white/60">We’ll be in touch as the next cohort takes shape.</p>
              </div>
            ) : (
              <>
                <p className="text-xs font-semibold tracking-[0.23em] text-[#b7d58e]">BETA TESTING</p>
                <h2 id="beta-title" className="mt-3 font-serif text-4xl">Help shape Thesis.</h2>
                <p className="mt-3 text-white/60">Join the waitlist for our next testing cohort.</p>
                <form onSubmit={submitBeta} className="mt-7 space-y-4">
                  <input ref={betaEmail} name="email" type="email" required autoComplete="email" defaultValue={email} placeholder="Email address" className="min-h-14 w-full rounded-xl border border-white/15 bg-white/[0.04] px-4 text-white outline-none transition placeholder:text-white/35 focus:border-[#b7d58e]" />
                  <input name="name" type="text" autoComplete="name" placeholder="Name (optional)" className="min-h-14 w-full rounded-xl border border-white/15 bg-white/[0.04] px-4 text-white outline-none transition placeholder:text-white/35 focus:border-[#b7d58e]" />
                  <input name="company" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
                  {betaError && <p className="text-sm text-red-300">{betaError}</p>}
                  <button type="submit" disabled={betaState === "loading"} className="min-h-14 w-full rounded-xl bg-[#b7d58e] font-semibold text-[#07101e] transition hover:bg-[#c8e49f] disabled:opacity-70">{betaState === "loading" ? "Submitting…" : "Apply for beta access"}</button>
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
