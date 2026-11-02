/** A minimal component model with Angular's decorator shape. */
export interface ComponentMeta {
  selector: string;
  template?: string;
  styles?: string[];
  templateUrl?: string;
  styleUrl?: string;
}

const META = new WeakMap<object, ComponentMeta>();

export function Component(meta: ComponentMeta) {
  return <T extends abstract new (...args: never[]) => object>(cls: T): T => {
    META.set(cls, meta);
    return cls;
  };
}

/** Renders a component's template, interpolating `{{ field }}` from an instance. */
export function render(cls: new () => object): { html: string; styles: string } {
  const meta = META.get(cls);
  if (!meta?.template) throw new Error(`${cls.name} has no template`);
  const instance = new cls() as Record<string, unknown>;
  const html = meta.template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => String(instance[k] ?? ""))
    .trim();
  return { html, styles: (meta.styles ?? []).join("\n") };
}
