"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { SearchIcon } from "../primitives/icons";
import type { CommandPaletteProps, PaletteCommand } from "./types";
import "./command-palette.css";

/**
 * CommandPalette — a ⌘K action surface.
 *
 * Rendering and accessibility notes:
 *  - Mounted through a portal on <body> so it is never clipped by a panel's
 *    overflow and always sits above the rail's stacking context.
 *  - Follows the WAI-ARIA combobox pattern: the input owns `aria-expanded`,
 *    `aria-controls` and `aria-activedescendant`; results are a `listbox` of
 *    `option`s. That keeps one tab stop and lets the screen reader announce
 *    the active option without focus ever leaving the input.
 *  - A `div role="option"` is used rather than `<li>`-as-option so the selected
 *    highlight follows `aria-activedescendant` and arrow keys drive a roving
 *    active index instead of moving DOM focus.
 */

function score(command: PaletteCommand, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const label = command.label.toLowerCase();
  const group = command.group.toLowerCase();
  const keywords = (command.keywords ?? []).map((k) => k.toLowerCase());

  if (label.startsWith(q)) return 100;
  if (label.includes(q)) return 80;
  if (group.includes(q)) return 60;
  if (keywords.some((k) => k.includes(q))) return 40;
  return 0;
}

export function CommandPalette({
  open,
  onOpenChange,
  commands,
  placeholder = "Search commands…",
  label = "Command palette",
  emptyMessage = "No matching commands.",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const filtered = useMemo(() => {
    const scored = commands
      .map((command) => ({ command, score: score(command, query.trim()) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((entry) => entry.command);
  }, [commands, query]);

  // Group contiguous runs for rendering headers.
  const groups = useMemo(() => {
    const out: { group: string; items: PaletteCommand[] }[] = [];
    for (const command of filtered) {
      const last = out[out.length - 1];
      if (last && last.group === command.group) last.items.push(command);
      else out.push({ group: command.group, items: [command] });
    }
    return out;
  }, [filtered]);

  // Reset on each open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Focus after paint so the dialog is in the DOM first.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep the active option scrolled into view.
  useLayoutEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filtered]);

  const run = useCallback(
    (command: PaletteCommand) => {
      onOpenChange(false);
      command.onSelect?.();
    },
    [onOpenChange],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) =>
          filtered.length ? (i - 1 + filtered.length) % filtered.length : 0,
        );
      } else if (event.key === "Home") {
        event.preventDefault();
        setActiveIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setActiveIndex(Math.max(0, filtered.length - 1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const command = filtered[activeIndex];
        if (command) run(command);
      }
    },
    [activeIndex, filtered, onOpenChange, run],
  );

  if (!mounted || !open) return null;

  // Flatten index of the active option for aria-activedescendant.
  const activeId = filtered[activeIndex] ? `palette-opt-${filtered[activeIndex].id}` : undefined;
  let flatIndex = -1;

  return createPortal(
    <div
      className="cs-palette-root"
      onKeyDown={onKeyDown}
      role="presentation"
    >
      <div
        className="cs-palette__scrim"
        data-open={open ? "" : undefined}
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />

      <div
        className="cs-palette"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div className="cs-palette__search">
          <SearchIcon size={16} className="cs-palette__search-icon" />
          <input
            ref={inputRef}
            className="cs-palette__input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="cs-palette-list"
            aria-activedescendant={activeId}
            aria-label={label}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
          />
          <kbd className="cs-palette__esc">esc</kbd>
        </div>

        <div
          ref={listRef}
          id="cs-palette-list"
          className="cs-palette__list celastyle-scroll"
          role="listbox"
          aria-label="Commands"
        >
          {filtered.length === 0 ? (
            <div className="cs-palette__empty">{emptyMessage}</div>
          ) : (
            groups.map((group) => (
              <div className="cs-palette__group" key={group.group}>
                <div className="cs-palette__group-label">{group.group}</div>
                {group.items.map((command) => {
                  flatIndex += 1;
                  const isActive = flatIndex === activeIndex;
                  return (
                    <div
                      key={command.id}
                      id={`palette-opt-${command.id}`}
                      role="option"
                      aria-selected={isActive}
                      data-active={isActive ? "true" : undefined}
                      className="cs-palette__item"
                      onMouseMove={() => setActiveIndex(flatIndex)}
                      onClick={() => run(command)}
                    >
                      {command.icon ? (
                        <span className="cs-palette__item-icon" aria-hidden="true">
                          {command.icon}
                        </span>
                      ) : null}
                      <span className="cs-palette__item-label">{command.label}</span>
                      {command.hint ? (
                        <span className="cs-palette__item-hint">{command.hint}</span>
                      ) : null}
                      {command.shortcut ? (
                        <kbd className="cs-palette__item-shortcut">{command.shortcut}</kbd>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cs-palette__footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* -----------------------------------------------------------------------------
 * useCommandPalette — global ⌘K / Ctrl+K binding.
 * -----------------------------------------------------------------------------
 * Lives in its own hook so the palette stays a controlled component: the host
 * decides how the palette is mounted and where its commands come from, and the
 * shortcut binding is a separate, reusable concern.
 */
export function useCommandPalette(): {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
} {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggle();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { open, setOpen, toggle };
}
