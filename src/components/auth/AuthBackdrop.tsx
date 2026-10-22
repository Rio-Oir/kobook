// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The auth backdrop: a WebGL dot field with a static pool of light behind it.
 *
 * The grid is the React Bits `DotGrid` (see `DotGrid.tsx`): dots rest as a
 * texture, then lean away from the cursor and light up near it, so the
 * background moves *because of the reader* rather than drifting on its own —
 * which is the difference between "alive" and "something is sliding".
 *
 * Colours come from the auth surface's own tokens (`--auth-page` and
 * `--auth-dot`), blended at the same alpha the CSS texture used, so day and
 * night keep the exact dot density the card was designed against. The theme
 * attribute is observed, so toggling day/night re-tints the canvas without a
 * remount.
 *
 * Without WebGL2 the component renders nothing and the CSS dot texture
 * (`AuthUI` / `index.css`) is the fallback.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import DotGrid from "./DotGrid";

type Rgb = [number, number, number];

function supportsWebgl2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}

function readTriplet(el: HTMLElement, name: string): Rgb {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  const parts = raw.split(/[\s,]+/).map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function mix(ink: Rgb, page: Rgb, alpha: number): string {
  const value = ink.map((channel, i) => Math.round(page[i] * (1 - alpha) + channel * alpha));
  return `#${value.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export default function AuthBackdrop() {
  const ref = useRef<HTMLDivElement>(null);
  const supported = useMemo(supportsWebgl2, []);
  const finePointer = useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches,
    [],
  );
  const [colors, setColors] = useState({ base: "#303030", active: "#e6e6e6" });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const page = readTriplet(el, "--auth-page");
      const ink = readTriplet(el, "--auth-dot");
      // The CSS texture drew 1px dots with a radial gradient; a WebGL dot of
      // the same colour loses roughly half its coverage to antialiasing and
      // reads as "gone" on a near-black page. Lift the blend instead of
      // growing the dot, so the grid keeps its density.
      const cssAlpha =
        Number(getComputedStyle(el).getPropertyValue("--auth-dot-alpha")) || 0.16;
      const alpha = Math.min(0.9, cssAlpha * 1.7);
      setColors({
        base: mix(ink, page, alpha),
        active: mix(ink, page, 0.85),
      });
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`auth-bg${supported ? " has-gl" : ""}`} aria-hidden="true">
      {supported ? (
        <DotGrid
          baseColor={colors.base}
          activeColor={colors.active}
          dotSize={1.6}
          gap={16.4}
          proximity={170}
          strength={0.8}
          bounce={0.5}
          tension={0.5}
          returnDuration={0.85}
          shockRadius={300}
          shockStrength={2.5}
          swell={1.3}
          stretch={0.6}
          glow={0.55}
          intro
          mouseInteraction={finePointer}
          clickShock={finePointer}
        />
      ) : null}
    </div>
  );
}
