import 'ses';

// This sets up the secure environment
// We disable some of the taming to allow for more flexibility

// For configuration, see https://github.com/endojs/endo/blob/master/packages/ses/docs/lockdown.md

// Ambient SES globals: 'ses' ships no types, so declare the two names we use.
declare function lockdown(options?: Record<string, unknown>): void;
declare class Compartment {
  constructor(endowments?: Record<string, unknown>);
  evaluate(source: string): unknown;
}

let lockeddown = false;
export function lockdownSes(): void {
  if (lockeddown) return;
  lockeddown = true;
  lockdown({
    // basic devex and quality of life improvements
    localeTaming: 'unsafe',
    consoleTaming: 'unsafe',
    errorTaming: 'unsafe',
    stackFiltering: 'verbose',
    // allow eval outside of created compartments
    // (mineflayer dep "protodef" uses eval)
    evalTaming: 'unsafeEval',
  });
}

// Keep the original export name `lockdown` for callers: re-export under that alias.
// NOTE: the module-level function declaration above is the SES global; this const
// shadows it locally to preserve the source file's public API without recursion
// confusion — implementation delegates to the global via globalThis.
export { lockdownSes as lockdown };

export const makeCompartment = (endowments: Record<string, unknown> = {}): Compartment => {
  return new Compartment({
    // provide untamed Math, Date, etc
    Math,
    Date,
    // standard endowments
    ...endowments
  });
};
