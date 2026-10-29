#!/usr/bin/env node
/**
 * Generates the animated SVGs used by the README and the docs.
 *
 *   node scripts/brand/build-readme-assets.mjs
 *
 * Design rules (see documentation/design/motion.md):
 *   - Pure SVG + CSS keyframes. No JS, no external fonts, no SMIL. Renders on GitHub via <img>.
 *   - The *static* (un-animated) state is the final, fully-informative frame, so
 *     `prefers-reduced-motion: reduce` simply disables animation and still tells the story.
 *   - Motion carries meaning: it follows the impact pipeline (change → dependents → tests).
 *   - Every loop resets with a fade, never with a jump.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "../../documentation/assets");

// ── Design tokens (mirror documentation/design/design-system.md) ────────────────────────────
const T = {
  bg0: "#070B18",
  bg1: "#0E1530",
  panel: "#111A38",
  line: "#22305C",
  text: "#E8ECF8",
  muted: "#8C97BD",
  dim: "#56618A",
  cyan: "#22D3EE",
  violet: "#8B5CF6",
  pass: "#34D399",
  fail: "#FB7185",
  warn: "#FBBF24",
  skip: "#3A4567",
  sans: "ui-sans-serif, -apple-system, 'Segoe UI', Inter, Roboto, Helvetica, Arial, sans-serif",
  mono: "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace",
  ease: "cubic-bezier(0.22, 1, 0.36, 1)", // --st-ease-out-expo
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (n) => `${+n.toFixed(2)}%`;

const reducedMotion = `
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; }
  }`;

/** Shared defs: background gradient, grid, glow filter, brand gradient. */
function baseDefs(id) {
  return `
    <linearGradient id="${id}-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${T.bg0}"/>
      <stop offset="1" stop-color="${T.bg1}"/>
    </linearGradient>
    <linearGradient id="${id}-brand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${T.cyan}"/>
      <stop offset="1" stop-color="${T.violet}"/>
    </linearGradient>
    <pattern id="${id}-grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="#ffffff" stroke-opacity="0.045" stroke-width="1"/>
    </pattern>
    <filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`;
}

function frame(id, w, h, r = 24) {
  return `
  <rect width="${w}" height="${h}" rx="${r}" fill="url(#${id}-bg)"/>
  <rect width="${w}" height="${h}" rx="${r}" fill="url(#${id}-grid)"/>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${r}" fill="none" stroke="${T.line}"/>`;
}

/** The SmartTest mark: a check-mark drawn as a tiny dependency graph. */
function logoMark(x, y, size, id) {
  const s = size / 64;
  return `
  <g transform="translate(${x} ${y}) scale(${s})">
    <rect width="64" height="64" rx="16" fill="url(#${id}-brand)"/>
    <path d="M17 34 L28 45 L48 21" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.95"/>
    <circle cx="17" cy="34" r="5" fill="#fff"/>
    <circle cx="28" cy="45" r="5" fill="#fff"/>
    <circle cx="48" cy="21" r="6" fill="#fff"/>
    <circle cx="48" cy="21" r="2.5" fill="${T.violet}"/>
  </g>`;
}

// ── 1. HERO ─────────────────────────────────────────────────────────────────────────────────
function hero() {
  const id = "hero";
  const W = 1280;
  const H = 440;
  const D = 7; // seconds per loop

  // Abstract dependency constellation on the right. level: 0 = change, 1 = dependents, 2 = tests.
  const nodes = {
    src: { x: 790, y: 220, r: 11, level: 0 },
    a: { x: 920, y: 120, r: 8, level: 1 },
    b: { x: 935, y: 240, r: 8, level: 1 },
    c: { x: 900, y: 345, r: 8, level: 1 },
    t1: { x: 1090, y: 90, r: 9, level: 2, test: true },
    t2: { x: 1110, y: 200, r: 9, level: 2, test: true },
    t3: { x: 1095, y: 320, r: 9, level: 2, test: true },
    // unrelated (stay dim → skipped, not run)
    u1: { x: 830, y: 80, r: 6 },
    u2: { x: 1010, y: 395, r: 6 },
    u3: { x: 1180, y: 140, r: 7, test: true },
    u4: { x: 1190, y: 270, r: 7, test: true },
    u5: { x: 1175, y: 380, r: 7, test: true },
    u6: { x: 1010, y: 40, r: 5 },
  };
  const hot = [
    ["src", "a", 1],
    ["src", "b", 1],
    ["src", "c", 1],
    ["a", "t1", 2],
    ["b", "t2", 2],
    ["c", "t3", 2],
  ];
  const cold = [
    ["u1", "a"],
    ["u6", "t1"],
    ["u2", "c"],
    ["u1", "u6"],
    ["u3", "u6"],
    ["u4", "u2"],
    ["u5", "u2"],
    ["b", "u4"],
  ];
  // Timeline (percent of D)
  const tl = { l1: [8, 22], l2: [26, 40], hold: 86, out: 95 };

  const edgePath = (p, q) => {
    const a = nodes[p];
    const b = nodes[q];
    const mx = (a.x + b.x) / 2;
    return `M${a.x} ${a.y} C${mx} ${a.y} ${mx} ${b.y} ${b.x} ${b.y}`;
  };

  const css = `
  .t-sans { font-family: ${T.sans}; }
  .t-mono { font-family: ${T.mono}; }
  .edge-cold { stroke: ${T.line}; stroke-width: 1.5; fill: none; }
  .edge-hot { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 0; }
  .edge-hot.l1 { stroke: ${T.warn}; animation: draw1 ${D}s ${T.ease} infinite; }
  .edge-hot.l2 { stroke: ${T.pass}; animation: draw2 ${D}s ${T.ease} infinite; }
  @keyframes draw1 { 0%, ${pct(tl.l1[0])} { stroke-dashoffset: 1; opacity: 1 } ${pct(tl.l1[1])}, ${pct(tl.hold)} { stroke-dashoffset: 0; opacity: 1 } ${pct(tl.out)}, 100% { stroke-dashoffset: 0; opacity: 0 } }
  @keyframes draw2 { 0%, ${pct(tl.l2[0])} { stroke-dashoffset: 1; opacity: 1 } ${pct(tl.l2[1])}, ${pct(tl.hold)} { stroke-dashoffset: 0; opacity: 1 } ${pct(tl.out)}, 100% { stroke-dashoffset: 0; opacity: 0 } }

  .node { fill: ${T.panel}; stroke: ${T.dim}; stroke-width: 1.5; }
  .node.cold { opacity: 0.55; }
  .node.l1 { fill: ${T.violet}; stroke: ${T.violet}; animation: lit1 ${D}s ease-out infinite; }
  .node.l2 { fill: ${T.pass}; stroke: ${T.pass}; animation: lit2 ${D}s ease-out infinite; }
  @keyframes lit1 { 0%, ${pct(tl.l1[1] - 2)} { fill: ${T.panel}; stroke: ${T.dim} } ${pct(tl.l1[1] + 1)}, ${pct(tl.hold)} { fill: ${T.violet}; stroke: ${T.violet} } ${pct(tl.out)}, 100% { fill: ${T.panel}; stroke: ${T.dim} } }
  @keyframes lit2 { 0%, ${pct(tl.l2[1] - 2)} { fill: ${T.panel}; stroke: ${T.dim} } ${pct(tl.l2[1] + 1)}, ${pct(tl.hold)} { fill: ${T.pass}; stroke: ${T.pass} } ${pct(tl.out)}, 100% { fill: ${T.panel}; stroke: ${T.dim} } }

  .src-core { fill: ${T.warn}; }
  .ripple { fill: none; stroke: ${T.warn}; stroke-width: 2; transform-box: fill-box; transform-origin: center; opacity: 0; animation: ripple ${D / 2}s ease-out infinite; }
  .ripple.r2 { animation-delay: ${D / 4}s; }
  @keyframes ripple { 0% { transform: scale(1); opacity: 0.7 } 100% { transform: scale(4.2); opacity: 0 } }

  .check { fill: none; stroke: ${T.bg0}; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; animation: lit2check ${D}s ease-out infinite; }
  @keyframes lit2check { 0%, ${pct(tl.l2[1])} { opacity: 0 } ${pct(tl.l2[1] + 3)}, ${pct(tl.hold)} { opacity: 1 } ${pct(tl.out)}, 100% { opacity: 0 } }

  .skip-tag { animation: skipTag ${D}s ease-out infinite; }
  @keyframes skipTag { 0%, ${pct(tl.l2[1] + 4)} { opacity: 0 } ${pct(tl.l2[1] + 9)}, ${pct(tl.hold)} { opacity: 1 } ${pct(tl.out)}, 100% { opacity: 0 } }

  .reveal { opacity: 1; animation: reveal 1.2s ${T.ease} both; }
  .reveal.d1 { animation-delay: .15s } .reveal.d2 { animation-delay: .3s } .reveal.d3 { animation-delay: .45s }
  @keyframes reveal { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }

  .scan { animation: scan ${D}s linear infinite; }
  @keyframes scan { 0% { transform: translateX(-200px); opacity: 0 } 6% { opacity: .9 } 30% { opacity: .9 } 40%, 100% { transform: translateX(560px); opacity: 0 } }
  ${reducedMotion}`;

  const pills = ["Local-first", "Deterministic core", "AI-optional", "Explainable"];
  let px = 72;
  const pillSvg = pills
    .map((p) => {
      const w = p.length * 8.2 + 28;
      const g = `<g transform="translate(${px} 318)"><rect width="${w}" height="30" rx="15" fill="#ffffff" fill-opacity="0.04" stroke="${T.line}"/><text x="${w / 2}" y="20" text-anchor="middle" class="t-sans" font-size="13" fill="${T.muted}">${esc(p)}</text></g>`;
      px += w + 10;
      return g;
    })
    .join("\n    ");

  const nodeSvg = Object.entries(nodes)
    .map(([k, n]) => {
      if (k === "src") {
        return `<circle class="ripple" cx="${n.x}" cy="${n.y}" r="${n.r}"/><circle class="ripple r2" cx="${n.x}" cy="${n.y}" r="${n.r}"/><circle class="src-core" cx="${n.x}" cy="${n.y}" r="${n.r}" filter="url(#${id}-glow)"/>`;
      }
      const cls = n.level === 1 ? "l1" : n.level === 2 ? "l2" : "cold";
      const shape = n.test
        ? `<rect class="node ${cls}" x="${n.x - n.r}" y="${n.y - n.r}" width="${n.r * 2}" height="${n.r * 2}" rx="4"/>`
        : `<circle class="node ${cls}" cx="${n.x}" cy="${n.y}" r="${n.r}"/>`;
      const check = n.level === 2 ? `<path class="check" d="M${n.x - 4} ${n.y} l3 3 l5 -6"/>` : "";
      return shape + check;
    })
    .join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">SmartTest — Understand the change. Test what matters.</title>
  <desc id="d">A code change ripples through a dependency graph; only the three tests connected to it light up green, the unrelated tests stay dimmed and are skipped.</desc>
  <style>${css}</style>
  <defs>${baseDefs(id)}
    <radialGradient id="${id}-halo" cx="0.75" cy="0.5" r="0.45">
      <stop offset="0" stop-color="${T.violet}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${T.violet}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id}-scan" x1="0" x2="1">
      <stop offset="0" stop-color="${T.cyan}" stop-opacity="0"/>
      <stop offset="1" stop-color="${T.cyan}" stop-opacity="0.35"/>
    </linearGradient>
  </defs>
  ${frame(id, W, H)}
  <rect width="${W}" height="${H}" rx="24" fill="url(#${id}-halo)"/>

  <g class="reveal">${logoMark(72, 92, 56, id)}</g>
  <text x="144" y="138" class="t-sans reveal" font-size="54" font-weight="800" letter-spacing="-1.5" fill="${T.text}">SmartTest</text>
  <text x="72" y="214" class="t-sans reveal d1" font-size="30" font-weight="700" letter-spacing="-0.5" fill="${T.text}">Understand the change.</text>
  <text x="72" y="252" class="t-sans reveal d1" font-size="30" font-weight="700" letter-spacing="-0.5" fill="url(#${id}-brand)">Test what matters.</text>
  <text x="72" y="290" class="t-sans reveal d2" font-size="16" fill="${T.muted}">Semantic test-impact analysis for TypeScript &amp; JavaScript.</text>
  <g class="reveal d3">
    ${pillSvg}
  </g>
  <text x="72" y="392" class="t-mono reveal d3" font-size="14" fill="${T.dim}"><tspan fill="${T.cyan}">$</tspan> npx smarttest run --affected</text>

  <g>
    <rect class="scan" x="640" y="20" width="120" height="${H - 40}" fill="url(#${id}-scan)" opacity="0"/>
    ${cold.map(([p, q]) => `<path class="edge-cold" d="${edgePath(p, q)}"/>`).join("\n    ")}
    ${hot.map(([p, q]) => `<path class="edge-cold" d="${edgePath(p, q)}"/>`).join("\n    ")}
    ${hot.map(([p, q, l]) => `<path class="edge-hot l${l}" pathLength="1" d="${edgePath(p, q)}"/>`).join("\n    ")}
    ${nodeSvg}
    <g class="skip-tag t-mono" font-size="11" fill="${T.dim}">
      <text x="1180" y="168" text-anchor="middle">skipped</text>
      <text x="1190" y="298" text-anchor="middle">skipped</text>
      <text x="1175" y="408" text-anchor="middle">skipped</text>
    </g>
    <g class="t-mono" font-size="11" fill="${T.muted}">
      <text x="790" y="256" text-anchor="middle" fill="${T.warn}">changed</text>
      <text x="1110" y="226" text-anchor="middle" fill="${T.pass}" class="skip-tag">selected</text>
    </g>
  </g>
</svg>
`;
}

// ── 2. PIPELINE ─────────────────────────────────────────────────────────────────────────────
function pipeline() {
  const id = "pipe";
  const W = 1280;
  const H = 250;
  const D = 8;
  const stages = [
    ["Changes", "git · snapshots"],
    ["Semantic diff", "AST · uncertainty"],
    ["Symbols", "classes · methods"],
    ["Dependency graph", "static + observed"],
    ["Rules & safety", "modes · mandatory"],
    ["Selection", "explainable"],
    ["Run & report", "jest · vitest"],
  ];
  const chipW = 158;
  const gap = (W - 80 - chipW * stages.length) / (stages.length - 1);
  const y = 112;
  const chipH = 64;
  const xs = stages.map((_, i) => 40 + i * (chipW + gap));
  const cx = xs.map((x) => x + chipW / 2);
  const travelEnd = 84; // % of loop when the pulse reaches the last stage
  const at = (i) => (i / (stages.length - 1)) * travelEnd;

  const chipCss = stages
    .map((_, i) => {
      const t = at(i);
      const on = Math.max(t - 1, 0);
      return `
  .chip-${i} .box { animation: chip${i} ${D}s ease-out infinite; }
  .chip-${i} .ttl { animation: chipt${i} ${D}s ease-out infinite; }
  @keyframes chip${i} { 0%, ${pct(on)} { stroke: ${T.line}; fill: ${T.panel} } ${pct(t + 1)}, ${pct(92)} { stroke: ${i === stages.length - 1 ? T.pass : T.cyan}; fill: #142049 } 98%, 100% { stroke: ${T.line}; fill: ${T.panel} } }
  @keyframes chipt${i} { 0%, ${pct(on)} { fill: ${T.muted} } ${pct(t + 1)}, ${pct(92)} { fill: ${T.text} } 98%, 100% { fill: ${T.muted} } }`;
    })
    .join("");

  const css = `
  .t-sans { font-family: ${T.sans}; } .t-mono { font-family: ${T.mono}; }
  .box { fill: #142049; stroke: ${T.cyan}; stroke-width: 1.5; }
  .chip-${stages.length - 1} .box { stroke: ${T.pass}; }
  .ttl { fill: ${T.text}; }
  .rail-hot { stroke: url(#${id}-brand); stroke-width: 3; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 0; animation: rail ${D}s linear infinite; }
  @keyframes rail { 0% { stroke-dashoffset: 1; opacity: 1 } ${pct(travelEnd)}, 92% { stroke-dashoffset: 0; opacity: 1 } 98%, 100% { stroke-dashoffset: 0; opacity: 0 } }
  .pulse { transform: translateX(${cx.at(-1) - cx[0]}px); opacity: 0; animation: travel ${D}s linear infinite; }
  @keyframes travel { 0% { transform: translateX(0); opacity: 0 } 2% { opacity: 1 } ${pct(travelEnd)} { transform: translateX(${cx.at(-1) - cx[0]}px); opacity: 1 } 90%, 100% { transform: translateX(${cx.at(-1) - cx[0]}px); opacity: 0 } }
  ${chipCss}
  ${reducedMotion}`;

  const chips = stages
    .map(
      ([title, sub], i) => `
  <g class="chip-${i}">
    <rect class="box" x="${xs[i]}" y="${y - chipH / 2}" width="${chipW}" height="${chipH}" rx="14"/>
    <text class="t-mono" x="${xs[i] + 14}" y="${y - 10}" font-size="11" fill="${T.dim}">0${i + 1}</text>
    <text class="t-sans ttl" x="${xs[i] + 14}" y="${y + 14}" font-size="14.5" font-weight="650">${esc(title)}</text>
    <text class="t-mono" x="${cx[i]}" y="${y + chipH / 2 + 26}" font-size="11.5" text-anchor="middle" fill="${T.muted}">${esc(sub)}</text>
  </g>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">The SmartTest impact pipeline</title>
  <desc id="d">Seven stages: changes, semantic diff, symbols, dependency graph, rules and safety, selection, run and report. A pulse travels through each stage in order.</desc>
  <style>${css}</style>
  <defs>${baseDefs(id)}</defs>
  ${frame(id, W, H)}
  <text class="t-mono" x="40" y="42" font-size="12" letter-spacing="2" fill="${T.dim}">IMPACT PIPELINE</text>
  <text class="t-sans" x="${W - 40}" y="42" font-size="13" text-anchor="end" fill="${T.muted}">deterministic · explainable · conservative fallbacks</text>
  <line x1="${cx[0]}" y1="${y}" x2="${cx.at(-1)}" y2="${y}" stroke="${T.line}" stroke-width="3" stroke-linecap="round"/>
  <line class="rail-hot" pathLength="1" x1="${cx[0]}" y1="${y}" x2="${cx.at(-1)}" y2="${y}"/>
  ${chips}
  <g class="pulse"><circle cx="${cx[0]}" cy="${y - chipH / 2 - 1}" r="5" fill="${T.cyan}" filter="url(#${id}-glow)"/></g>
</svg>
`;
}

// ── 3. TERMINAL ─────────────────────────────────────────────────────────────────────────────
function terminal() {
  const id = "term";
  const W = 960;
  const H = 540;
  const D = 14;
  const cmd = "npx smarttest run --affected";
  const typeStart = 4;
  const typeEnd = 18;
  const x0 = 36;
  const y0 = 96;
  const lh = 27;
  const c = T;

  // [text segments, appearAt%] — segments: [text, color, bold?]
  const lines = [
    [
      [
        ["◇ ", c.cyan],
        ["Changes   ", c.muted],
        ["git · main…HEAD · 3 files · 5 symbols", c.text],
      ],
      22,
    ],
    [
      [
        ["◇ ", c.cyan],
        ["Analysis  ", c.muted],
        ["complete · warm graph · 182 ms", c.text],
      ],
      26,
    ],
    [
      [
        ["◇ ", c.cyan],
        ["Mode      ", c.muted],
        ["balanced", c.violet],
        ["  rule: authentication-critical", c.dim],
      ],
      30,
    ],
    [[], 0],
    [
      [
        ["  SELECTED ", c.bg0, "pill-pass"],
        ["  12 of 486 tests · 2.5%", c.text],
      ],
      36,
    ],
    [
      [
        ["  ✓ ", c.pass],
        ["src/auth/AuthService.test.ts         ", c.text],
        ["8 passed  412 ms", c.muted],
      ],
      42,
    ],
    [
      [
        ["  ✓ ", c.pass],
        ["src/auth/AuthController.test.ts      ", c.text],
        ["3 passed  188 ms", c.muted],
      ],
      46,
    ],
    [
      [
        ["  ✓ ", c.pass],
        ["test/routes/protected.test.ts        ", c.text],
        ["1 passed   96 ms", c.muted],
      ],
      50,
    ],
    [
      [
        ["  SKIPPED  ", c.text, "pill-skip"],
        ["  474 tests · not run · no static or observed link", c.muted],
      ],
      56,
    ],
    [[], 0],
    [[["  ✓ ", c.pass], ["12 passed", c.pass], " · 0 failed · 474 skipped (not run) · 2.1 s"], 62],
    [
      [
        ["  ↳ ", c.dim],
        ["why these tests? ", c.muted],
        ["smarttest explain", c.cyan],
      ],
      68,
    ],
  ];
  // normalise the bare string segment above
  for (const l of lines) l[0] = l[0].map((s) => (typeof s === "string" ? [s, c.muted] : s));

  const hold = 90;
  const out = 97;
  const lineCss = lines
    .map(([, t], i) =>
      t
        ? `.ln-${i} { animation: ln${i} ${D}s ease-out infinite; }
  @keyframes ln${i} { 0%, ${pct(t)} { opacity: 0; transform: translateY(6px) } ${pct(t + 2.5)}, ${pct(hold)} { opacity: 1; transform: none } ${pct(out)}, 100% { opacity: 0 } }`
        : "",
    )
    .join("\n  ");

  const charW = 9.02; // approx advance of a 15px monospace glyph
  const cmdX = x0 + 2 * charW;
  const cmdW = cmd.length * charW;

  const css = `
  .mono { font-family: ${T.mono}; font-size: 15px; white-space: pre; }
  .cover { animation: type ${D}s steps(${cmd.length}, end) infinite; }
  @keyframes type { 0%, ${pct(typeStart)} { transform: translateX(0) } ${pct(typeEnd)}, 100% { transform: translateX(${cmdW + 12}px) } }
  .caret { animation: caretMove ${D}s steps(${cmd.length}, end) infinite, blink 1s step-end infinite; }
  @keyframes caretMove { 0%, ${pct(typeStart)} { transform: translateX(0) } ${pct(typeEnd)}, 100% { transform: translateX(${cmdW + 4}px) } }
  @keyframes blink { 50% { opacity: 0 } }
  .spinner { transform-box: fill-box; transform-origin: center; animation: spin .9s linear infinite, spinVis ${D}s linear infinite; opacity: 0; }
  @keyframes spin { to { transform: rotate(360deg) } }
  @keyframes spinVis { 0%, ${pct(typeEnd + 1)} { opacity: 0 } ${pct(typeEnd + 2)}, ${pct(60)} { opacity: 1 } ${pct(61)}, 100% { opacity: 0 } }
  .fade-cmd { animation: fadeCmd ${D}s ease-out infinite; }
  @keyframes fadeCmd { 0%, ${pct(hold)} { opacity: 1 } ${pct(out)} { opacity: 0 } 100% { opacity: 1 } }
  ${lineCss}
  ${reducedMotion.replace("}\n", "}\n    .cover { display: none } .caret { display: none }\n")}`;

  const renderLine = ([segs], i) => {
    if (segs.length === 0) return "";
    const y = y0 + 44 + i * lh;
    let x = x0;
    const parts = segs
      .map(([text, color, pill]) => {
        const w = text.length * charW;
        let s = "";
        if (pill) {
          const bg = pill === "pill-pass" ? c.pass : c.skip;
          s += `<rect x="${x + 2 * charW - 6}" y="${y - 16}" width="${w - 2 * charW + 4}" height="22" rx="5" fill="${bg}"/>`;
        }
        s += `<text class="mono" x="${x}" y="${y}" fill="${color}"${pill ? ' font-weight="700"' : ""}>${esc(text)}</text>`;
        x += w;
        return s;
      })
      .join("");
    return `<g class="ln-${i}">${parts}</g>`;
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">smarttest run --affected</title>
  <desc id="d">Terminal session: SmartTest analyses 3 changed files, selects 12 of 486 tests, runs them with Vitest, reports 474 tests as skipped and not run, and points to smarttest explain.</desc>
  <style>${css}</style>
  <defs>${baseDefs(id)}</defs>
  <rect width="${W}" height="${H}" rx="18" fill="${T.bg0}"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="18" fill="none" stroke="${T.line}"/>
  <rect x="0" y="0" width="${W}" height="46" rx="18" fill="#0B1126"/>
  <rect x="0" y="28" width="${W}" height="18" fill="#0B1126"/>
  <line x1="0" y1="46" x2="${W}" y2="46" stroke="${T.line}"/>
  <circle cx="26" cy="23" r="6.5" fill="#FF5F57"/><circle cx="48" cy="23" r="6.5" fill="#FEBC2E"/><circle cx="70" cy="23" r="6.5" fill="#28C840"/>
  <text x="${W / 2}" y="28" text-anchor="middle" font-family="${T.sans}" font-size="13" fill="${T.muted}">~/acme-api — smarttest</text>

  <g class="fade-cmd">
    <text class="mono" x="${x0}" y="${y0}" fill="${T.cyan}">$</text>
    <text class="mono" x="${cmdX}" y="${y0}" fill="${T.text}">${esc(cmd)}</text>
    <rect class="cover" x="${cmdX - 2}" y="${y0 - 18}" width="${cmdW + 16}" height="26" fill="${T.bg0}"/>
    <rect class="caret" x="${cmdX}" y="${y0 - 15}" width="9" height="19" fill="${T.cyan}" opacity="0.9"/>
    <g class="spinner"><circle cx="${cmdX + cmdW + 28}" cy="${y0 - 5}" r="7" fill="none" stroke="${T.violet}" stroke-width="2.5" stroke-dasharray="30 14" stroke-linecap="round"/></g>
  </g>
  ${lines.map(renderLine).join("\n  ")}
</svg>
`;
}

// ── 4. IMPACT MAP ───────────────────────────────────────────────────────────────────────────
function impactMap() {
  const id = "imp";
  const W = 1280;
  const H = 560;
  const D = 9;
  const cw = 254;
  const ch = 58;
  const cols = [40, 356, 672];
  const tl = { l1: [6, 20], l2: [24, 38], skip: 42, card: 46, hold: 88, out: 96 };

  const cards = {
    src: {
      col: 0,
      y: 170,
      title: "AuthService.validateToken()",
      sub: "modified · implementation",
      kind: "changed",
    },
    ctl: { col: 1, y: 90, title: "AuthController", sub: "direct dependent", kind: "l1" },
    mid: { col: 1, y: 250, title: "AuthenticationMiddleware", sub: "direct dependent", kind: "l1" },
    t0: { col: 2, y: 90, title: "AuthController.test.ts", sub: "transitive", kind: "l2" },
    t1: { col: 2, y: 170, title: "AuthService.test.ts", sub: "direct · TESTS edge", kind: "l1t" },
    t2: { col: 2, y: 250, title: "ProtectedRoutes.test.ts", sub: "transitive · rule", kind: "l2" },
    cat: { col: 0, y: 420, title: "CatalogService", sub: "unchanged", kind: "cold" },
    tc: { col: 2, y: 420, title: "CatalogService.test.ts", sub: "skipped · not run", kind: "skip" },
  };
  const edges = [
    ["src", "ctl", "l1"],
    ["src", "mid", "l1"],
    ["src", "t1", "l1t"],
    ["ctl", "t0", "l2"],
    ["mid", "t2", "l2"],
  ];

  const xy = (k, side) => {
    const c = cards[k];
    const x = cols[c.col] + (side === "r" ? cw : 0);
    return [x, c.y];
  };
  const curve = (a, b) => {
    const [x1, y1] = xy(a, "r");
    const [x2, y2] = xy(b, "l");
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  };

  const color = {
    changed: T.warn,
    l1: T.violet,
    l1t: T.pass,
    l2: T.pass,
    cold: T.dim,
    skip: T.dim,
  };
  const litAt = { l1: tl.l1[1], l1t: tl.l1[1], l2: tl.l2[1] };

  const css = `
  .t-sans { font-family: ${T.sans}; } .t-mono { font-family: ${T.mono}; }
  .card { fill: ${T.panel}; stroke: ${T.line}; stroke-width: 1.5; }
  .card.changed { stroke: ${T.warn}; animation: pulseChanged 2.2s ease-in-out infinite; }
  @keyframes pulseChanged { 50% { stroke-opacity: .45 } }
  .card.l1 { stroke: ${T.violet}; animation: litL1 ${D}s ease-out infinite; }
  .card.l1t { stroke: ${T.pass}; animation: litL1t ${D}s ease-out infinite; }
  .card.l2 { stroke: ${T.pass}; animation: litL2 ${D}s ease-out infinite; }
  @keyframes litL1 { 0%, ${pct(litAt.l1 - 1)} { stroke: ${T.line} } ${pct(litAt.l1 + 1)}, ${pct(tl.hold)} { stroke: ${T.violet} } ${pct(tl.out)}, 100% { stroke: ${T.line} } }
  @keyframes litL1t { 0%, ${pct(litAt.l1t - 1)} { stroke: ${T.line} } ${pct(litAt.l1t + 1)}, ${pct(tl.hold)} { stroke: ${T.pass} } ${pct(tl.out)}, 100% { stroke: ${T.line} } }
  @keyframes litL2 { 0%, ${pct(litAt.l2 - 1)} { stroke: ${T.line} } ${pct(litAt.l2 + 1)}, ${pct(tl.hold)} { stroke: ${T.pass} } ${pct(tl.out)}, 100% { stroke: ${T.line} } }
  .badge-l1t, .badge-l2, .badge-l1 { animation: badgeIn ${D}s ease-out infinite; }
  .badge-l1, .badge-l1t { animation-name: badgeIn1; }
  @keyframes badgeIn1 { 0%, ${pct(tl.l1[1])} { opacity: 0 } ${pct(tl.l1[1] + 3)}, ${pct(tl.hold)} { opacity: 1 } ${pct(tl.out)}, 100% { opacity: 0 } }
  @keyframes badgeIn { 0%, ${pct(tl.l2[1])} { opacity: 0 } ${pct(tl.l2[1] + 3)}, ${pct(tl.hold)} { opacity: 1 } ${pct(tl.out)}, 100% { opacity: 0 } }
  .dimmed { animation: dim ${D}s ease-out infinite; opacity: .45; }
  @keyframes dim { 0%, ${pct(tl.skip)} { opacity: 1 } ${pct(tl.skip + 4)}, ${pct(tl.hold)} { opacity: .45 } ${pct(tl.out)}, 100% { opacity: 1 } }
  .edge { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 0; }
  .edge.l1 { stroke: ${T.violet}; animation: e1 ${D}s ${T.ease} infinite; }
  .edge.l1t { stroke: ${T.pass}; animation: e1 ${D}s ${T.ease} infinite; }
  .edge.l2 { stroke: ${T.pass}; animation: e2 ${D}s ${T.ease} infinite; }
  @keyframes e1 { 0%, ${pct(tl.l1[0])} { stroke-dashoffset: 1; opacity: 1 } ${pct(tl.l1[1])}, ${pct(tl.hold)} { stroke-dashoffset: 0; opacity: 1 } ${pct(tl.out)}, 100% { stroke-dashoffset: 0; opacity: 0 } }
  @keyframes e2 { 0%, ${pct(tl.l2[0])} { stroke-dashoffset: 1; opacity: 1 } ${pct(tl.l2[1])}, ${pct(tl.hold)} { stroke-dashoffset: 0; opacity: 1 } ${pct(tl.out)}, 100% { stroke-dashoffset: 0; opacity: 0 } }
  .why { animation: why ${D}s ${T.ease} infinite; }
  @keyframes why { 0%, ${pct(tl.card)} { opacity: 0; transform: translateX(16px) } ${pct(tl.card + 6)}, ${pct(tl.hold)} { opacity: 1; transform: none } ${pct(tl.out)}, 100% { opacity: 0 } }
  ${reducedMotion}`;

  const cardSvg = Object.values(cards)
    .map((c) => {
      const x = cols[c.col];
      const y = c.y - ch / 2;
      const dot = color[c.kind];
      const isTest = c.title.endsWith(".ts");
      const label = {
        changed: "MODIFIED",
        l1: "AFFECTED",
        l1t: "SELECTED",
        l2: "SELECTED",
        skip: "SKIPPED",
        cold: "",
      }[c.kind];
      const labelColor = {
        changed: T.warn,
        l1: T.violet,
        l1t: T.pass,
        l2: T.pass,
        skip: T.muted,
        cold: T.dim,
      }[c.kind];
      const badgeCls = ["l1", "l1t", "l2"].includes(c.kind) ? `badge-${c.kind}` : "";
      const group = ["cold", "skip"].includes(c.kind) ? "dimmed" : "";
      return `
  <g class="${group}">
    <rect class="card ${c.kind}" x="${x}" y="${y}" width="${cw}" height="${ch}" rx="12"${c.kind === "skip" ? ' stroke-dasharray="5 5"' : ""}/>
    ${isTest ? `<rect x="${x + 14}" y="${c.y - 13}" width="10" height="10" rx="2.5" fill="${dot}"/>` : `<circle cx="${x + 19}" cy="${c.y - 8}" r="5" fill="${dot}"/>`}
    <text class="t-mono" x="${x + 32}" y="${c.y - 3}" font-size="13" fill="${T.text}">${esc(c.title)}</text>
    <text class="t-sans" x="${x + 32}" y="${c.y + 17}" font-size="11.5" fill="${T.muted}">${esc(c.sub)}</text>
    ${label ? `<text class="t-mono ${badgeCls}" x="${x + cw - 12}" y="${y - 7}" font-size="10.5" letter-spacing="1.2" text-anchor="end" fill="${labelColor}">${label}</text>` : ""}
  </g>`;
    })
    .join("");

  const wx = 958;
  const wy = 70;
  const ww = 282;
  const why = `
  <g class="why">
    <rect x="${wx}" y="${wy}" width="${ww}" height="232" rx="14" fill="#0B1229" stroke="${T.line}"/>
    <text class="t-mono" x="${wx + 18}" y="${wy + 30}" font-size="11" letter-spacing="1.5" fill="${T.dim}">$ SMARTTEST EXPLAIN</text>
    <text class="t-mono" x="${wx + 18}" y="${wy + 60}" font-size="12.5" fill="${T.pass}">SELECTED</text>
    <text class="t-mono" x="${wx + 90}" y="${wy + 60}" font-size="12.5" fill="${T.text}">ProtectedRoutes.test.ts</text>
    <text class="t-sans" x="${wx + 18}" y="${wy + 90}" font-size="12.5" fill="${T.muted}">Reasons</text>
    <text class="t-sans" x="${wx + 18}" y="${wy + 114}" font-size="12.5" fill="${T.text}">• Modified symbol: validateToken</text>
    <text class="t-sans" x="${wx + 18}" y="${wy + 136}" font-size="12.5" fill="${T.text}">• Transitive via Authentication…</text>
    <text class="t-sans" x="${wx + 18}" y="${wy + 158}" font-size="12.5" fill="${T.text}">• Rule: authentication-critical</text>
    <line x1="${wx + 18}" y1="${wy + 176}" x2="${wx + ww - 18}" y2="${wy + 176}" stroke="${T.line}"/>
    <text class="t-sans" x="${wx + 18}" y="${wy + 200}" font-size="12" fill="${T.muted}">Analysis: <tspan fill="${T.pass}">complete</tspan> · mode: <tspan fill="${T.violet}">balanced</tspan></text>
    <text class="t-sans" x="${wx + 18}" y="${wy + 220}" font-size="12" fill="${T.dim}">Skipped tests are reported as not run.</text>
  </g>`;

  const legend = [
    ["Modified", T.warn],
    ["Affected", T.violet],
    ["Selected", T.pass],
    ["Skipped (not run)", T.dim],
  ];
  let lx = 40;
  const legendSvg = legend
    .map(([l, col]) => {
      const g = `<circle cx="${lx + 5}" cy="${H - 36}" r="5" fill="${col}"/><text class="t-sans" x="${lx + 16}" y="${H - 32}" font-size="12.5" fill="${T.muted}">${l}</text>`;
      lx += l.length * 7.4 + 44;
      return g;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
  <title id="t">Impact map: from a modified method to the tests that protect it</title>
  <desc id="d">AuthService.validateToken is modified. Its dependents AuthController and AuthenticationMiddleware are affected; AuthService.test, AuthController.test and ProtectedRoutes.test are selected. CatalogService.test has no relationship and is skipped, not run. An explanation panel lists the reasons for selecting ProtectedRoutes.test.</desc>
  <style>${css}</style>
  <defs>${baseDefs(id)}</defs>
  ${frame(id, W, H)}
  <text class="t-mono" x="40" y="34" font-size="12" letter-spacing="2" fill="${T.dim}">IMPACT MAP · src/modules/auth</text>
  ${edges.map(([a, b]) => `<path d="${curve(a, b)}" fill="none" stroke="${T.line}" stroke-width="1.5"/>`).join("\n  ")}
  <path d="${curve("cat", "tc")}" fill="none" stroke="${T.line}" stroke-width="1.5" stroke-dasharray="4 6" class="dimmed"/>
  <text class="t-sans dimmed" x="${(cols[0] + cw + cols[2]) / 2}" y="410" font-size="12" text-anchor="middle" fill="${T.dim}">no static or observed relationship</text>
  ${edges.map(([a, b, k]) => `<path class="edge ${k}" pathLength="1" d="${curve(a, b)}"/>`).join("\n  ")}
  ${cardSvg}
  ${why}
  ${legendSvg}
  <text class="t-sans" x="${W - 40}" y="${H - 32}" font-size="12.5" text-anchor="end" fill="${T.dim}">Every selection has a traceable reason.</text>
</svg>
`;
}

// ── 5. Small logo (favicon / package README) ───────────────────────────────────────────────
function logo() {
  const id = "logo";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64" role="img" aria-label="SmartTest logo">
  <defs>${baseDefs(id)}</defs>
  ${logoMark(0, 0, 64, id)}
</svg>
`;
}

await mkdir(outDir, { recursive: true });
const assets = {
  "hero.svg": hero(),
  "pipeline.svg": pipeline(),
  "terminal.svg": terminal(),
  "impact-map.svg": impactMap(),
  "logo.svg": logo(),
};
for (const [name, svg] of Object.entries(assets)) {
  await writeFile(join(outDir, name), svg);
  console.log(`✔ documentation/assets/${name} (${(svg.length / 1024).toFixed(1)} KB)`);
}
