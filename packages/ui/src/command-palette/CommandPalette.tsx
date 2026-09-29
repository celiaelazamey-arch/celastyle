"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SearchIcon } from "../primitives/icons";
import type { CommandPaletteProps, PaletteCommand } from "./types";

/**
 * CommandPalette — a ⌘K action surface.
 *
 * Uses the WAI-ARIA combobox pattern: the input owns `aria-expanded`,
 * `aria-controls` and `aria-activedescendant`, and the results are a `listbox`
 * of `option`s. That gives one tab stop and lets a screen reader announce the
 * active option without focus ever leaving the input — which a row of real
 * `<button>`s cannot do, because moving between them steals focus and breaks
 * typing.
 *
 * Mounted through a portal on <body> so panel `overflow` can never clip it.
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
  placeholder = "Type a command or search evidence…",
  label = "Command palette",
  emptyMessage = "No matching commands found.",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const filtered = useMemo(() => {
    return commands
      .map((command) => ({ command, score: score(command, query.trim()) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command);
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

  // Reset on open, move focus in, and remember the trigger so focus can be
  // handed back on close — otherwise a keyboard user is dumped at the top of
  // the document every time they dismiss the palette.
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      restoreRef.current?.focus?.();
      restoreRef.current = null;
    }
  }, [open]);

  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filtered]);

  const run = useCallback(
    (command: PaletteCommand) => {
      onOpenChange(false);
      command.onSelect?.();
    },
    [onOpenChange],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          onOpenChange(false);
          break;
        case "ArrowDown":
          event.preventDefault();
          setActiveIndex((i) => (filtered.length ? (i + 1) % filtered.length : 0));
          break;
        case "ArrowUp":
          event.preventDefault();
          setActiveIndex((i) =>
            filtered.length ? (i - 1 + filtered.length) % filtered.length : 0,
          );
          break;
        case "Home":
          event.preventDefault();
          setActiveIndex(0);
          break;
        case "End":
          event.preventDefault();
          setActiveIndex(Math.max(0, filtered.length - 1));
          break;
        case "Enter": {
          event.preventDefault();
          const command = filtered[activeIndex];
          if (command) run(command);
          break;
        }
        default:
          break;
      }
    },
    [activeIndex, filtered, onOpenChange, run],
  );

  if (!mounted || !open) return null;

  const active = filtered[activeIndex];
  const activeId = active ? `palette-opt-${active.id}` : undefined;
  let flatIndex = -1;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-20"
      onKeyDown={onKeyDown}
      role="presentation"
    >
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-md motion-safe:animate-[celastyle-fade-in_var(--duration-fast)_var(--ease-decelerate)]"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-full max-w-xl overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-2xl motion-safe:animate-[celastyle-palette-in_var(--duration-normal)_var(--ease-emphasized)]"
      >
        {/* --- Search --- */}
        <div className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-4">
          <SearchIcon size={16} className="shrink-0 text-[var(--text-dim)]" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="cs-palette-list"
            aria-activedescendant={activeId}
            aria-label={label}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder={placeholder}
            className="w-full bg-transparent py-3 font-mono text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-dim)]"
          />
          <kbd className="shrink-0 rounded border border-[var(--border-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-dim)]">
            ESC
          </kbd>
        </div>

        {/* --- Results --- */}
        <div
          ref={listRef}
          id="cs-palette-list"
          role="listbox"
          aria-label="Commands"
          className="celastyle-scroll max-h-72 p-2"
        >
          {filtered.length === 0 ? (
            <div className="p-4 text-center font-mono text-xs text-[var(--text-dim)]">
              {emptyMessage}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.group} className={group.group === groups[0]?.group ? "" : "mt-2"}>
                <div className="px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--text-dim)]">
                  {group.group}
                </div>
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
                      onMouseMove={() => setActiveIndex(flatIndex)}
                      onClick={() => run(command)}
                      className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2.5 font-mono text-xs transition-colors ${
                        isActive
                          ? "border border-[var(--accent-lime-alpha-20)] bg-[var(--accent-lime-alpha-10)] text-[var(--accent-lime)]"
                          : "border border-transparent text-[var(--text-primary)] hover:bg-[var(--bg-surface)]"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {command.icon ? (
                          <span aria-hidden="true" className="shrink-0">
                            {command.icon}
                          </span>
                        ) : null}
                        <span className="truncate font-medium">{command.label}</span>
                      </span>
                      {command.shortcut ? (
                        <kbd className="shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                          {command.shortcut}
                        </kbd>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* --- Footer --- */}
        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] bg-[var(--bg-primary)] px-4 py-2 font-mono text-[10px] text-[var(--text-dim)]">
          <span>↑ ↓ to select · ↵ to run · esc to close</span>
          <span>Cela Command Center</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * useCommandPalette — global ⌘K / Ctrl+K binding.
 *
 * Kept as a separate hook so the palette stays a controlled component.
 *
 * Note `toLowerCase()`: with Shift held the event reports "K", and a bare
 * `e.key === "k"` comparison silently fails to match ⌘⇧K.
 */
export function useCommandPalette(): {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
} {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
