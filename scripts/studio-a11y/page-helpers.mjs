/**
 * Page-side accessibility helpers for the Studio audits. The function is self-contained: Playwright
 * installs it as an init script, and WebDriver (scripts/studio-a11y/safari.mjs) sends its source
 * with `(${pageHelpers})()` after each page load. It defines `window.__a11y`.
 */
export function pageHelpers() {
  const FOCUSABLE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';
  const LIVE = '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';
  const text = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const desc = (el) => {
    if (!el || el === document.body || el === document.documentElement) return "body";
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const id = el.dataset?.fk ? `{${el.dataset.fk}}` : el.id ? `#${el.id}` : "";
    const name = text(
      el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || el.value,
    ).slice(0, 60);
    return `${tag}${role ? `[role=${role}]` : ""}${id} "${name}"`;
  };
  const visible = (el) =>
    el.isConnected &&
    !el.closest("[inert]") &&
    (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true) &&
    el.getClientRects().length > 0;
  const focusables = () =>
    [...document.querySelectorAll(FOCUSABLE)].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && visible(el),
    );
  const keyOf = (el) => {
    const list = focusables();
    return `${desc(el)}@${list.indexOf(el)}`;
  };
  const hitsElement = (el, x, y) => {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { ok: false, by: null };
    const hit = document.elementFromPoint(x, y);
    if (!hit) return { ok: false, by: null };
    if (hit === el || el.contains(hit)) return { ok: true, by: null };
    // A <label> wrapping the control, or an ancestor hit through pointer-events: none.
    if (hit.contains(el) && !hit.matches(".drawer, .rail, .toast, .dialog")) return { ok: true };
    return { ok: false, by: hit };
  };
  window.__a11y = {
    desc,
    expected: () => focusables().map((el) => `${desc(el)}@${focusables().indexOf(el)}`),
    focusInfo() {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement || !document.hasFocus())
        return { key: "body", desc: "body" };
      const r = el.getBoundingClientRect();
      const points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 2, r.top + 2],
        [r.right - 2, r.top + 2],
        [r.left + 2, r.bottom - 2],
        [r.right - 2, r.bottom - 2],
      ];
      const hits = points.map(([x, y]) => hitsElement(el, x, y));
      const shown = hits.filter((h) => h.ok).length;
      const blocker = hits.find((h) => !h.ok && h.by)?.by ?? null;
      return {
        key: keyOf(el),
        desc: desc(el),
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        inDrawer: Boolean(el.closest("#run")),
        inDialog: Boolean(el.closest('[role="dialog"]')),
        obscured: shown === 0 ? "entirely" : shown < points.length ? "partly" : null,
        obscuredBy: blocker
          ? blocker.closest("#run")
            ? "run drawer"
            : blocker.closest(".rail")
              ? "navigation rail"
              : desc(blocker)
          : null,
        focusVisible: el.matches(":focus-visible"),
      };
    },
    focusFirst() {
      focusables()[0]?.focus();
    },
    isLast() {
      const list = focusables();
      return list.at(-1) === document.activeElement;
    },
    focusKey(key) {
      const el = focusables().find((e) => keyOf(e) === key);
      el?.focus();
      return Boolean(el);
    },
    blur() {
      document.activeElement?.blur?.();
    },
    async pixelDiff(a, b) {
      const load = async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return createImageBitmap(new Blob([bytes], { type: "image/png" }));
      };
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const read = (img) => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const c = canvas.getContext("2d");
        c.drawImage(img, 0, 0);
        return c.getImageData(0, 0, w, h).data;
      };
      const da = read(ia);
      const db = read(ib);
      let changed = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d =
          Math.abs(da[i] - db[i]) +
          Math.abs(da[i + 1] - db[i + 1]) +
          Math.abs(da[i + 2] - db[i + 2]);
        if (d > 60) changed++;
      }
      return changed;
    },
    structure() {
      const issues = [];
      const mains = document.querySelectorAll('main, [role="main"]');
      if (mains.length !== 1) issues.push(`${mains.length} main landmarks (expected 1)`);
      const headings = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")]
        .filter(visible)
        .map((el) => ({
          level: Number(el.getAttribute("aria-level") ?? el.tagName.slice(1)),
          text: text(el.textContent).slice(0, 50),
        }));
      const h1 = headings.filter((h) => h.level === 1);
      if (h1.length !== 1) issues.push(`${h1.length} h1 headings (expected 1)`);
      if (headings.length && headings[0].level !== 1)
        issues.push(`first heading is h${headings[0].level} "${headings[0].text}"`);
      for (let i = 1; i < headings.length; i++)
        if (headings[i].level > headings[i - 1].level + 1)
          issues.push(
            `heading jumps from h${headings[i - 1].level} to h${headings[i].level} at "${headings[i].text}"`,
          );
      const labelled = (sel) =>
        [...document.querySelectorAll(sel)].filter(visible).map((el) => ({
          el,
          name: text(
            el.getAttribute("aria-label") ||
              document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent,
          ),
        }));
      for (const role of ["nav, [role=navigation]", "aside, [role=complementary]"]) {
        const items = labelled(role);
        if (items.length > 1 && items.some((i) => !i.name))
          issues.push(`several ${role.split(",")[0]} landmarks and one has no label`);
        const names = items.map((i) => i.name);
        if (new Set(names).size !== names.length)
          issues.push(`duplicate ${role.split(",")[0]} labels`);
      }
      const outside = [...document.body.children].filter(
        (el) =>
          visible(el) &&
          !el.matches(
            "main, nav, aside, header, footer, [role], .skip-link, script, noscript, #toast",
          ) &&
          !el.querySelector("main, [role=main]") &&
          text(el.textContent),
      );
      for (const el of outside) issues.push(`content outside any landmark: ${desc(el)}`);
      return { issues, headings };
    },
    targets() {
      const sel =
        'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="tab"], [role="button"], [tabindex]:not([tabindex="-1"])';
      const all = [...document.querySelectorAll(sel)].filter(
        (el) => visible(el) && !el.matches(".skip-link"),
      );
      const rects = all.map((el) => ({ el, r: el.getBoundingClientRect() }));
      const small = rects.filter(({ el, r }) => {
        if (r.width >= 23.5 && r.height >= 23.5) return false;
        // Inline links inside a sentence are exempt (WCAG 2.5.8 "inline").
        if (
          el.tagName === "A" &&
          el.parentElement &&
          text(el.parentElement.textContent) !== text(el.textContent)
        )
          return false;
        return true;
      });
      const issues = [];
      const circle = ({ r }) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2, rad: 12 });
      const hitsRect = (c, r) => {
        const nx = Math.max(r.left, Math.min(c.x, r.right));
        const ny = Math.max(r.top, Math.min(c.y, r.bottom));
        return (nx - c.x) ** 2 + (ny - c.y) ** 2 < c.rad ** 2;
      };
      for (const s of small) {
        const c = circle(s);
        const clash = rects.find(
          (o) =>
            o !== s &&
            !o.el.contains(s.el) &&
            !s.el.contains(o.el) &&
            (hitsRect(c, o.r) ||
              (small.includes(o) &&
                (() => {
                  const d = circle(o);
                  return (d.x - c.x) ** 2 + (d.y - c.y) ** 2 < (c.rad + d.rad) ** 2;
                })())),
        );
        if (clash)
          issues.push(
            `${desc(s.el)} is ${Math.round(s.r.width)}x${Math.round(s.r.height)} px and too close to ${desc(clash.el)}`,
          );
      }
      return issues;
    },
    motion() {
      const seconds = (list) =>
        Math.max(
          0,
          ...list.split(",").map((v) => {
            const n = Number.parseFloat(v);
            return v.trim().endsWith("ms") ? n / 1000 : n;
          }),
        );
      const issues = [];
      for (const el of document.querySelectorAll("*")) {
        for (const pseudo of [null, "::before", "::after"]) {
          const cs = getComputedStyle(el, pseudo);
          if (cs.animationName !== "none" && seconds(cs.animationDuration) > 0.01)
            issues.push(`${desc(el)}${pseudo ?? ""} animates for ${cs.animationDuration}`);
          if (
            cs.transitionProperty !== "none" &&
            seconds(cs.transitionDuration) > 0.01 &&
            !(cs.transitionProperty === "all" && cs.transitionDuration === "0s")
          )
            issues.push(`${desc(el)}${pseudo ?? ""} transitions for ${cs.transitionDuration}`);
        }
      }
      if (getComputedStyle(document.documentElement).scrollBehavior === "smooth")
        issues.push("html scrolls smoothly");
      return [...new Set(issues)].slice(0, 20);
    },
    reflow() {
      const doc = document.scrollingElement ?? document.documentElement;
      const vw = document.documentElement.clientWidth;
      const issues = [];
      if (doc.scrollWidth > vw + 1)
        issues.push(
          `page scrolls horizontally: ${doc.scrollWidth}px content in a ${vw}px viewport`,
        );
      const scrollsX = (el) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.position === "fixed") return "fixed";
          if (["auto", "scroll"].includes(cs.overflowX)) return "scroll";
          if (["hidden", "clip"].includes(cs.overflowX)) return "clip";
        }
        return null;
      };
      const offenders = [];
      for (const el of document.querySelectorAll("#app *, #run *")) {
        if (!visible(el) || el.closest("[inert]")) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right <= vw + 1 && r.left >= -1) continue;
        const how = scrollsX(el);
        // A control in a fixed bar that sticks out of the viewport cannot be scrolled into view.
        if (how === "fixed" && el.matches("a[href], button, input, select, textarea")) {
          offenders.push(`${desc(el)} sits off screen in a fixed bar`);
          continue;
        }
        if (how === "scroll" || how === "fixed" || how === "clip") continue;
        if ([...el.children].some((c) => c.getBoundingClientRect().right > vw + 1)) continue;
        offenders.push(`${desc(el)} spans ${Math.round(r.left)}–${Math.round(r.right)}px`);
      }
      return [...issues, ...offenders.slice(0, 8)];
    },
    installLive() {
      const seen = new WeakMap();
      const log = [];
      window.__live = log;
      for (const r of document.querySelectorAll(LIVE)) seen.set(r, -1);
      const observer = new MutationObserver((mutations) => {
        const now = performance.now();
        const touched = new Set();
        for (const m of mutations) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            const regions = [...(n.matches(LIVE) ? [n] : []), ...n.querySelectorAll(LIVE)];
            for (const r of regions)
              if (!seen.has(r)) {
                seen.set(r, now);
                const t = text(r.textContent);
                if (t) log.push({ kind: "inserted", region: desc(r), text: t.slice(0, 200) });
              }
          }
          const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
          const region = target?.closest?.(LIVE);
          if (region) touched.add(region);
        }
        for (const r of touched) {
          const born = seen.get(r);
          if (born === undefined || born === now || !r.isConnected) continue;
          const t = text(r.textContent);
          if (!t) continue;
          const hidden = Boolean(r.closest('[aria-hidden="true"], [inert]'));
          log.push({
            kind: hidden ? "hidden" : "announced",
            region: desc(r),
            text: t.slice(0, 200),
          });
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    },
  };
}
