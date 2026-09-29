import type { SVGProps } from "react";
import { cn } from "../lib/cn";

export type IconProps = SVGProps<SVGSVGElement> & {
  /** Rendered box size. Icons are square and scale from the box, not the
   *  stroke — so a 20px icon keeps the same optical weight as a 16px one. */
  size?: number;
};

/**
 * Base icon wrapper.
 *
 * Every icon in the system inherits from this so stroke weight, line caps and
 * the size box stay identical across the set. A 1.5px stroke at 16px is the
 * optical weight that holds up next to 14px Graphite text without reading as
 * heavy; going thicker makes a dense rail look like clip art.
 */
export function Icon({ size = 16, className, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("cs-icon", className)}
      {...props}
    >
      {children}
    </svg>
  );
}
