// Prompt bundle loader (spec §22.3 — the app update mechanism for
// AI prompts).
//
// Every AI instruction text of this app lives in prompts.json (the
// bundle). The bundle bundled with the app is the initial state.
// When the space is opened, the server checks the distributor's
// repository for a newer bundle (checkPromptUpdate in actions.ts)
// and, when the frame validation below passes, applies it
// automatically: the applied bundle is kept in the prompt_versions
// table together with the immediately previous one, so a plan set
// can pin the version its runs use and the owner can roll back one
// version. This module is the pure part: parsing, the frame
// validation, placeholder filling, and the in-memory hold of the
// applied / previous bundles. Database access lives in actions.ts
// (refreshPromptBundles / pinPromptBundleForSet).
//
// The frame validation is the ONLY judgement applied to a fetched
// bundle: version shape, the compatibility of the structure
// version (checked by the caller against the manifest), the key
// set (exactly the bundled keys — no missing, no unknown), value
// types (all strings), size limits, and the placeholder allowlist
// (each key's {{placeholder}} names must equal the bundled key's
// set, so a fetched bundle can neither introduce a new placeholder
// nor drop one the code fills). Anything outside the frame is
// rejected whole; there is no partial application.

import bundledJson from "./prompts.json";

// The prompt file's structure version: the shape of prompts.json
// (its keys and each key's placeholders) that this code can fill.
// A fetched bundle is applied only when the manifest's
// compatibility range covers this number.
export const PROMPT_STRUCTURE_VER = 1;

const MAX_VALUE_CHARS = 200_000;
const MAX_TOTAL_CHARS = 1_000_000;
const PLACEHOLDER_RE = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g;

export interface PromptBundle {
  ver: number;
  // The key's text with no placeholder filling. Throws when the key
  // carries placeholders (use fill) — a bundled key with
  // placeholders read as plain text is a programming error.
  text(key: string): string;
  // The key's text with every {{placeholder}} replaced by the
  // given values. Throws when a placeholder has no value: an
  // unfilled placeholder must never reach the AI. Values render
  // exactly as a template literal would render them
  // (String(value); null renders as "null").
  fill(
    key: string,
    values?: Record<string, string | number | null>,
  ): string;
}

function placeholdersOf(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/g)) {
    if (m[1]) names.add(m[1]);
  }
  return names;
}

function makeBundle(ver: number, prompts: Record<string, string>): PromptBundle {
  const fillFrom = (
    key: string,
    values?: Record<string, string | number | null>,
  ): string => {
    const raw = prompts[key];
    if (typeof raw !== "string") throw new Error(`unknown prompt key: ${key}`);
    return raw.replace(PLACEHOLDER_RE, (_whole, name: string) => {
      const v = values?.[name];
      if (v === undefined) {
        throw new Error(`unfilled placeholder in prompt ${key}: {{${name}}}`);
      }
      return String(v);
    });
  };
  return {
    ver,
    text(key: string): string {
      const raw = prompts[key];
      if (typeof raw !== "string") throw new Error(`unknown prompt key: ${key}`);
      if (placeholdersOf(raw).size > 0) {
        throw new Error(`prompt key has placeholders, use fill: ${key}`);
      }
      return raw;
    },
    fill(
      key: string,
      values?: Record<string, string | number | null>,
    ): string {
      return fillFrom(key, values);
    },
  };
}

interface BundledDoc {
  format: number;
  ver: number;
  prompts: Record<string, string>;
}

const bundledDoc = bundledJson as unknown as BundledDoc;

// The bundle bundled with the app: the initial state of every copy,
// and the fallback whenever no applied bundle is stored.
export const BUNDLED_PROMPTS_VER: number = bundledDoc.ver;
const BUNDLED_BUNDLE: PromptBundle = makeBundle(bundledDoc.ver, bundledDoc.prompts);

export function bundledBundle(): PromptBundle {
  return BUNDLED_BUNDLE;
}

const REQUIRED_KEYS: string[] = Object.keys(bundledDoc.prompts).sort();
const BUNDLED_PLACEHOLDERS = new Map<string, Set<string>>(
  REQUIRED_KEYS.map((k) => [
    k,
    placeholdersOf(bundledDoc.prompts[k] as string),
  ]),
);

// The in-memory hold: the applied bundle and the immediately
// previous one. Seeded from the database by refreshPromptBundles
// (actions.ts) at every entry point that builds prompts; before
// the first load, the bundled bundle is active.
let appliedBundle: PromptBundle = BUNDLED_BUNDLE;
let previousBundle: PromptBundle | null = null;

export function setPromptBundles(
  applied: PromptBundle,
  previous: PromptBundle | null,
): void {
  appliedBundle = applied;
  previousBundle = previous;
}

export function activeBundle(): PromptBundle {
  return appliedBundle;
}

export function previousBundleOrNull(): PromptBundle | null {
  return previousBundle;
}

// The bundle for a pinned version: the applied one, the previous
// one, or the bundled one. Null when the version is no longer held
// (the caller then falls back to the applied bundle).
export function bundleForVer(ver: number): PromptBundle | null {
  if (appliedBundle.ver === ver) return appliedBundle;
  if (previousBundle && previousBundle.ver === ver) return previousBundle;
  if (BUNDLED_BUNDLE.ver === ver) return BUNDLED_BUNDLE;
  return null;
}

export type PromptBundleValidation =
  | { ok: true; bundle: PromptBundle }
  | { ok: false; errorClass: string };

// The frame validation for a fetched prompts.json body. Returns a
// machine-readable error class on failure (recorded in the prompt
// update state; never shown raw to the user). The hash and size
// checks against the manifest are the caller's job and run before
// this.
export function validatePromptBundleText(
  text: string,
): PromptBundleValidation {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, errorClass: "parse" };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, errorClass: "shape" };
  }
  const d = doc as Record<string, unknown>;
  if (d.format !== 1) return { ok: false, errorClass: "format" };
  if (typeof d.ver !== "number" || !Number.isInteger(d.ver) || d.ver < 1) {
    return { ok: false, errorClass: "ver" };
  }
  if (
    typeof d.prompts !== "object" ||
    d.prompts === null ||
    Array.isArray(d.prompts)
  ) {
    return { ok: false, errorClass: "shape" };
  }
  const prompts = d.prompts as Record<string, unknown>;
  const keys = Object.keys(prompts).sort();
  if (
    keys.length !== REQUIRED_KEYS.length ||
    keys.some((k, i) => k !== REQUIRED_KEYS[i])
  ) {
    return { ok: false, errorClass: "keys" };
  }
  const clean: Record<string, string> = {};
  let total = 0;
  for (const k of REQUIRED_KEYS) {
    const v = prompts[k];
    if (typeof v !== "string") return { ok: false, errorClass: "type" };
    if (v.length > MAX_VALUE_CHARS) return { ok: false, errorClass: "size" };
    total += v.length;
    clean[k] = v;
  }
  if (total > MAX_TOTAL_CHARS) return { ok: false, errorClass: "size" };
  for (const k of REQUIRED_KEYS) {
    const want = BUNDLED_PLACEHOLDERS.get(k) as Set<string>;
    const got = placeholdersOf(clean[k] as string);
    if (got.size !== want.size || [...got].some((n) => !want.has(n))) {
      return { ok: false, errorClass: "placeholders" };
    }
  }
  return { ok: true, bundle: makeBundle(d.ver as number, clean) };
}
