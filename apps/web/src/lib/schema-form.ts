import type { ModuleClient, ModuleManifest } from '@dash/contract';
import { z } from 'zod';

/** What the settings dialog and catalog need of a registry entry; the generated `clientModules` satisfies it. */
export type EditEntry = {
  manifest: Pick<ModuleManifest, 'id' | 'name' | 'description' | 'icon' | 'multiInstance' | 'tile' | 'settings'>;
  load?: () => Promise<{ default: ModuleClient }>;
};
export type EditRegistry = Record<string, EditEntry>;

/** Value setters used by the form components. */
export type Setter = (value: unknown) => void;
export type FormChange = (value: Record<string, unknown>) => void;

export type StringWidget = 'text' | 'textarea' | 'url' | 'color' | 'icon' | 'secret' | 'timezone';
const WIDGETS: readonly string[] = ['text', 'textarea', 'url', 'color', 'icon', 'secret', 'timezone'];

export type FieldSpec = { key: string; label: string; help?: string; required: boolean; default?: unknown } & (
  | { kind: 'string'; widget?: StringWidget }
  | { kind: 'number'; min?: number; max?: number; step?: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: string[] }
  | { kind: 'list'; of: FieldSpec }
  | { kind: 'group'; fields: FieldSpec[] }
);

// The slice of Zod 4's public `._zod.def` this module reads.
interface Check {
  check?: string;
  value?: number;
  format?: string;
}
interface Def {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  entries?: Record<string, unknown>;
  defaultValue?: unknown;
  format?: string;
  checks?: { _zod: { def: Check } }[];
}
const defOf = (s: z.ZodType): Def => s._zod.def;

export function humanize(key: string): string {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function unsupported(path: string, what: string): Error {
  return new Error(
    `Cannot generate a settings form for "${path}" (${what}): this module must ship its own Settings component.`,
  );
}

interface Unwrapped {
  inner: z.ZodType;
  required: boolean;
  nullable: boolean;
  hasDefault: boolean;
  dflt: unknown;
  meta: { label?: string; help?: string; widget?: string };
}

function unwrap(schema: z.ZodType): Unwrapped {
  const out: Unwrapped = { inner: schema, required: true, nullable: false, hasDefault: false, dflt: undefined, meta: {} };
  for (;;) {
    const m = z.globalRegistry.get(out.inner) as Unwrapped['meta'] | undefined;
    if (m) {
      for (const k of ['label', 'help', 'widget'] as const) {
        if (out.meta[k] === undefined && typeof m[k] === 'string') out.meta[k] = m[k];
      }
    }
    const def = defOf(out.inner);
    if (def.type === 'optional') out.required = false;
    else if (def.type === 'nullable') out.nullable = true;
    else if (def.type === 'default' || def.type === 'prefault') {
      if (!out.hasDefault) {
        out.hasDefault = true;
        out.dflt = typeof def.defaultValue === 'function' ? (def.defaultValue as () => unknown)() : def.defaultValue;
      }
    } else return out;
    if (!def.innerType) return out;
    out.inner = def.innerType;
  }
}

function describeField(key: string, schema: z.ZodType, path: string, depth: number): FieldSpec {
  const u = unwrap(schema);
  const def = defOf(u.inner);
  const base: Omit<FieldSpec, 'kind'> = {
    key,
    label: u.meta.label ?? humanize(key),
    ...(u.meta.help !== undefined ? { help: u.meta.help } : {}),
    required: u.required && !u.hasDefault && !u.nullable,
  };
  const withDefault = <T extends FieldSpec>(spec: T): T => {
    if (u.hasDefault) spec.default = u.dflt;
    else if (u.nullable && u.required) spec.default = null; // nullable-only: an empty control means null
    return spec;
  };

  switch (def.type) {
    case 'string': {
      let widget = u.meta.widget;
      if (widget !== undefined && !WIDGETS.includes(widget)) throw unsupported(path, `unknown widget "${widget}"`);
      if (widget === undefined && def.format === 'url') widget = 'url';
      return withDefault({ ...base, kind: 'string', ...(widget ? { widget: widget as StringWidget } : {}) });
    }
    case 'number': {
      let min: number | undefined;
      let max: number | undefined;
      let step: number | undefined;
      for (const c of def.checks ?? []) {
        const d = c._zod.def;
        if (d.check === 'greater_than' && d.value !== undefined) min = d.value;
        else if (d.check === 'less_than' && d.value !== undefined) max = d.value;
        else if (d.check === 'multiple_of' && d.value !== undefined) step = d.value;
        else if (d.check === 'number_format' && (d.format === 'int32' || d.format === 'safeint' || d.format === 'uint32')) step ??= 1;
      }
      return withDefault({
        ...base,
        kind: 'number',
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        ...(step !== undefined ? { step } : {}),
      });
    }
    case 'boolean':
      return withDefault({ ...base, kind: 'boolean' });
    case 'enum': {
      const options = Object.values(def.entries ?? {});
      if (!options.every((o): o is string => typeof o === 'string')) throw unsupported(path, 'non-string enum');
      return withDefault({ ...base, kind: 'enum', options });
    }
    case 'array': {
      if (depth > 0 || !def.element) throw unsupported(path, 'nested list');
      const el = unwrap(def.element);
      const elDef = defOf(el.inner);
      if (elDef.type === 'array') throw unsupported(`${path}[]`, 'list of lists');
      const of =
        elDef.type === 'object'
          ? ({
              key: '',
              label: el.meta.label ?? humanize(key),
              required: true,
              kind: 'group',
              fields: describeObject(el.inner as z.ZodObject, `${path}[]`, 1),
            } as FieldSpec)
          : describeField('', def.element, `${path}[]`, 1);
      return withDefault({ ...base, kind: 'list', of });
    }
    case 'object': {
      if (depth > 0) throw unsupported(path, 'object nested more than one level');
      return withDefault({ ...base, kind: 'group', fields: describeObject(u.inner as z.ZodObject, path, 1) });
    }
    default:
      throw unsupported(path, def.type);
  }
}

function describeObject(schema: z.ZodObject, prefix: string, depth: number): FieldSpec[] {
  const fields = Object.entries(schema.shape as Record<string, z.ZodType>).map(([key, s]) =>
    describeField(key, s, prefix ? `${prefix}.${key}` : key, depth),
  );
  if (depth > 0) {
    // A stored secret cannot be tracked per list item or round-tripped inside a group safely.
    for (const f of fields) {
      if (f.kind === 'string' && f.widget === 'secret' && prefix.endsWith('[]')) {
        throw unsupported(`${prefix}.${f.key}`, 'secret inside a list');
      }
    }
  }
  return fields;
}

export function describeSchema(schema: z.ZodObject): FieldSpec[] {
  return describeObject(schema, '', 0);
}

function emptyOf(spec: FieldSpec): unknown {
  if (spec.default !== undefined && spec.default !== null) return structuredClone(spec.default);
  switch (spec.kind) {
    case 'string':
      return '';
    case 'number':
      return '';
    case 'boolean':
      return false;
    case 'enum':
      return spec.required ? (spec.options[0] ?? '') : '';
    case 'list':
      return [];
    case 'group':
      return emptyValue(spec.fields);
  }
}

/** Defaults for a fresh form: strings and numbers are '' (numbers are text until `coerce`). */
export function emptyValue(fields: FieldSpec[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f.key, emptyOf(f)]));
}

/** Form state for stored settings: stored values over `emptyValue`. */
export function fillForm(fields: FieldSpec[], stored: unknown): Record<string, unknown> {
  const src = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const out = emptyValue(fields);
  for (const f of fields) {
    const v = src[f.key];
    if (v === undefined || v === null) continue;
    if (f.kind === 'group') out[f.key] = fillForm(f.fields, v);
    else if (f.kind === 'list' && Array.isArray(v)) {
      out[f.key] = v.map((item: unknown) => (f.of.kind === 'group' ? fillForm(f.of.fields, item) : item));
    } else out[f.key] = v;
  }
  return out;
}

const isEmpty = (raw: unknown): boolean => raw === undefined || raw === null || raw === '';

function coerceValue(spec: FieldSpec, raw: unknown): unknown {
  switch (spec.kind) {
    case 'string':
    case 'enum':
      if (isEmpty(raw)) return spec.required ? '' : spec.default === null ? null : undefined;
      return raw;
    case 'number': {
      if (isEmpty(raw)) return spec.default === null ? null : undefined;
      if (typeof raw === 'number') return raw;
      const n = Number(raw);
      return typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(n) ? n : raw;
    }
    case 'boolean':
      return raw === undefined || raw === null ? undefined : Boolean(raw);
    case 'list':
      return Array.isArray(raw) ? raw.map((item) => coerceValue(spec.of, item)) : [];
    case 'group':
      return coerce(spec.fields, raw);
  }
}

/** Turn form state into the value handed to Zod: numeric strings to numbers, empty optionals to undefined, recursively. */
export function coerce(fields: FieldSpec[], raw: unknown): Record<string, unknown> {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = coerceValue(f, src[f.key]);
    if (v !== undefined) out[f.key] = v;
  }
  return out;
}

/** Map zod issues to dotted-path messages; the first message per path wins. Empty-path issues land under ''. */
export function issuesToErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const p = i.path.map(String).join('.');
    out[p] ??= i.message;
  }
  return out;
}
