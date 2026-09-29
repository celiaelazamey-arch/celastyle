import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "../lib/cn";
import type { CommandRailItem, CommandRailProps } from "./types";
import "./command-rail.css";

/**
 * Command Rail — the primary navigation spine of a multi-panel workspace.
 *
 * Implemented as a WAI-ARIA tablist with vertical orientation, because that is
 * what it actually is: a set of peer panels, exactly one of which is showing.
 * A `nav`/`link` model would be wrong, because selecting an item does not
 * navigate away — it swaps the visible panel in place.
 *
 * Keyboard behaviour follows the tabs pattern: roving tabindex (one Tab stop
 * for the whole rail), and arrow keys move between items with automatic
 * activation. Home/End jump to the ends.
 */
export function CommandRail({
  items,
  value,
  defaultValue,
  onValueChange,
  mode = "icon",
  label = "Workspace panels",
  header,
  footer,
  className,
}: CommandRailProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const [uncontrolled, setUncontrolled] = useState<string | undefined>(
    defaultValue,
  );
  const isControlled = value !== undefined;
  const selected = isControlled ? value : uncontrolled;

  // Fall back to the first enabled item so the rail is never rendered with
  // nothing selected (which would read as an empty, broken rail).
  const enabledItems = useMemo(
    () => items.filter((item) => !item.disabled),
    [items],
  );
  const activeId =
    selected && enabledItems.some((item) => item.id === selected)
      ? selected
      : enabledItems[0]?.id;

  const select = useCallback(
    (id: string) => {
      if (!isControlled) setUncontrolled(id);
      onValueChange?.(id);
    },
    [isControlled, onValueChange],
  );

  // Keep the DOM selection in sync when the caller controls `value` externally.
  useEffect(() => {
    if (isControlled && value && value !== activeId && enabledItems.length > 0) {
      // Externally driven change — reflect it without firing onValueChange,
      // otherwise we would loop back to the caller.
      setUncontrolled(value);
    }
  }, [isControlled, value, activeId, enabledItems.length]);

  const focusItem = useCallback((id: string) => {
    const node = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-rail-item="${CSS.escape(id)}"]`,
    );
    node?.focus();
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (enabledItems.length === 0) return;
      const currentIndex = enabledItems.findIndex(
        (item) => item.id === activeId,
      );
      const nextIndex =
        (currentIndex + delta + enabledItems.length) % enabledItems.length;
      const next = enabledItems[nextIndex];
      if (!next) return;
      select(next.id);
      focusItem(next.id);
    },
    [activeId, enabledItems, focusItem, select],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case "ArrowDown":
        case "ArrowRight":
          event.preventDefault();
          move(1);
          break;
        case "ArrowUp":
        case "ArrowLeft":
          event.preventDefault();
          move(-1);
          break;
        case "Home": {
          event.preventDefault();
          const first = enabledItems[0];
          if (first) {
            select(first.id);
            focusItem(first.id);
          }
          break;
        }
        case "End": {
          event.preventDefault();
          const last = enabledItems[enabledItems.length - 1];
          if (last) {
            select(last.id);
            focusItem(last.id);
          }
          break;
        }
        default:
          break;
      }
    },
    [enabledItems, focusItem, move, select],
  );

  return (
    <nav
      className={cn("cs-rail", className)}
      data-mode={mode}
      aria-label={label}
    >
      {header ? <div className="cs-rail__header">{header}</div> : null}

      <div
        ref={listRef}
        className="cs-rail__list"
        role="tablist"
        aria-orientation="vertical"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        {items.map((item: CommandRailItem) => {
          const isActive = item.id === activeId;

          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              data-rail-item={item.id}
              data-active={isActive || undefined}
              aria-selected={isActive}
              aria-controls={item.panelId}
              disabled={item.disabled}
              // Roving tabindex: the rail is a single tab stop.
              tabIndex={isActive ? 0 : -1}
              className="cs-rail__item"
              onClick={() => select(item.id)}
            >
              {/* Active indicator — a lime edge bar, drawn with a pseudo-element
                  so it never affects the item's box. */}
              <span className="cs-rail__indicator" aria-hidden="true" />

              {item.icon ? (
                <span className="cs-rail__icon">{item.icon}</span>
              ) : null}

              <span className="cs-rail__label">
                {item.label}
                {item.shortcut ? (
                  <kbd className="cs-rail__shortcut">{item.shortcut}</kbd>
                ) : null}
              </span>

              {item.badge !== undefined && item.badge !== 0 ? (
                <span className="cs-rail__badge">{item.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {footer ? <div className="cs-rail__footer">{footer}</div> : null}
    </nav>
  );
}
