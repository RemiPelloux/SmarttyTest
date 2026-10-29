// Documentation pages: phone menu and title search.
(() => {
  const toggle = document.querySelector(".nav-toggle");
  const sidebar = document.getElementById("sidebar");
  toggle?.addEventListener("click", () => {
    const open = sidebar.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  const input = document.querySelector("[data-search]");
  const box = document.querySelector("[data-results]");
  if (!input || !box) return;
  const base = input.dataset.base || "./";
  let index;
  const load = async () => {
    if (index) return index;
    const res = await fetch(`${base}assets/search.json`);
    index = await res.json();
    return index;
  };
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  input.addEventListener("input", async () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) {
      box.hidden = true;
      return;
    }
    const hits = [];
    for (const page of await load()) {
      if (page.t.toLowerCase().includes(q)) hits.push({ label: page.t, sub: "", url: page.u });
      for (const [text, id] of page.h)
        if (text.toLowerCase().includes(q) && text !== page.t)
          hits.push({ label: text, sub: page.t, url: `${page.u}#${id}` });
    }
    box.innerHTML = hits.length
      ? hits
          .slice(0, 12)
          .map(
            (h) =>
              `<a href="${base}${h.url}">${esc(h.label)}${h.sub ? `<small>${esc(h.sub)}</small>` : ""}</a>`,
          )
          .join("")
      : '<a aria-disabled="true">No match</a>';
    box.hidden = false;
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) box.hidden = true;
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") box.hidden = true;
    if (e.key === "ArrowDown") box.querySelector("a")?.focus();
  });
})();
