/**
 * Class name joiner.
 *
 * Mirrors the ergonomics of `clsx` without adding a dependency to a package
 * that is meant to stay at the bottom of the stack. Accepts strings, falsy
 * values, and arrays — enough for every conditional-style case a component in
 * this system needs.
 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[];

export function cn(...values: ClassValue[]): string {
  const out: string[] = [];

  for (const value of values) {
    if (!value && value !== 0) continue;

    if (Array.isArray(value)) {
      const nested = cn(...value);
      if (nested) out.push(nested);
    } else {
      out.push(String(value));
    }
  }

  return out.join(" ");
}
