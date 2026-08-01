"use client";

import { Globe3D } from "@/components/ui/3d-globe";

// The opening beat of the intro: a rotating Earth that spins FAST on appearance, then SMOOTHLY
// decelerates to a slow, continuous rotation. The spin-down is driven per-frame inside the globe
// (see Globe3D `spinDown`) so the settle has no bumps. Purely decorative — no fixed landing face.
export function ThesisIntroGlobe() {
  const PEAK = 50; // fast spin on appearance (autoRotate-speed units)
  const SLOW = 0.9; // slow continuous spin it eases down to
  const DECEL_S = 2.0; // seconds to slow down

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative" style={{ width: "min(70vw, 330px)", height: "min(70vw, 330px)", transform: "translateY(-7vh)" }}>
        <Globe3D
          className="!h-full !w-full"
          config={{
            showAtmosphere: false,
            bumpScale: 3,
            autoRotateSpeed: 0,
            spinDown: { peakSpeed: PEAK, slowSpeed: SLOW, durationMs: DECEL_S * 1000 },
            backgroundColor: null,
            ambientIntensity: 0.55,
            pointLightIntensity: 1.4,
          }}
        />
      </div>
    </div>
  );
}
