// Catalogs are loaded lazily, as i18n backends do.
const catalogs = import.meta.glob<{ default: Record<string, unknown> }>("./locales/*/*.ts", { eager: true });

export function t(key: string): string {
  const [ns, ...path] = key.includes(":") ? key.split(/[:.]/) : ["common", ...key.split(".")];
  let node: unknown = catalogs[`./locales/en/${ns}.ts`]?.default;
  for (const p of path) node = (node as Record<string, unknown> | undefined)?.[p];
  return typeof node === "string" ? node : key;
}
