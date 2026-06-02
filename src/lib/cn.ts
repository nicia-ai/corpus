import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Conditional class composition with Tailwind conflict resolution. The one
// place variant components merge classes — keeps later utilities winning
// over base ones instead of fighting source order.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
