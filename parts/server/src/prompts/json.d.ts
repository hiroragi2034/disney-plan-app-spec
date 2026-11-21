// Ambient declaration for the bundled prompts.json import in
// loader.ts, for toolchains where JSON module resolution is not
// enabled. The value is validated by the loader before use.
declare module "*.json" {
  const value: unknown;
  export default value;
}
