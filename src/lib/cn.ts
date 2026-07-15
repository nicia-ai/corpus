import { type ClassValue, clsx } from "clsx";

// Conditional class composition only. Shared components own their variants;
// intentional one-off utility overrides use Tailwind's explicit `!` modifier
// instead of shipping a runtime parser for the entire Tailwind grammar.
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
