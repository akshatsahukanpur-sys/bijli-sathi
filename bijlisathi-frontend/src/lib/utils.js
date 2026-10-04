import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

// cn() — merges Tailwind classes intelligently (clsx + tailwind-merge)
// Use everywhere: cn("px-2 py-1", condition && "bg-amber-500", className)
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
