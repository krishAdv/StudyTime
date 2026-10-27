"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { computeMenuPlacement } from "@/lib/menu-position";
import { cn } from "@/lib/utils";

export type DropdownOption<T extends string> = { value: T; label: string };

const MARGIN = 16;

/**
 * Listbox dropdown whose menu is rendered in a portal with fixed positioning and
 * measured against the viewport, so it can never extend past the screen edges
 * (a menu absolutely positioned inside a card is clipped by or overflows it).
 */
export function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const labelId = useId();
  const listId = useId();

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIndex];

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    // Measure the menu at its natural size before constraining it.
    menu.style.width = "max-content";
    menu.style.maxHeight = "none";
    const r = trigger.getBoundingClientRect();
    const p = computeMenuPlacement({
      trigger: r,
      contentWidth: menu.scrollWidth,
      contentHeight: menu.scrollHeight,
      viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
      margin: MARGIN,
    });
    Object.assign(menu.style, {
      left: `${p.left}px`,
      top: `${p.top}px`,
      width: `${p.width}px`,
      maxHeight: `${p.maxHeight}px`,
      visibility: "visible",
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", close);
    };
  }, [open, place]);

  const openMenu = (index = selectedIndex) => {
    setActive(index);
    setOpen(true);
  };
  const choose = (i: number) => {
    onChange(options[i].value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    const last = options.length - 1;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(last, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className={cn("block min-w-0", className)}>
      <span id={labelId} className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        className="relative flex h-11 w-full min-w-0 items-center rounded-xl border border-border bg-card pl-3 pr-9 text-left text-base text-foreground sm:text-sm"
      >
        <span className="min-w-0 truncate">{selected?.label}</span>
        <ChevronDown
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open &&
        createPortal(
          <ul
            ref={menuRef}
            id={listId}
            role="listbox"
            aria-labelledby={labelId}
            // Hidden until `place` has measured and positioned it, so it never flashes off-screen.
            style={{ position: "fixed", left: MARGIN, top: 0, visibility: "hidden" }}
            className="z-50 overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-card p-1 text-foreground shadow-lg"
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={o.value === value}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(i)}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center justify-between gap-3 whitespace-normal break-words rounded-lg px-3 py-2 text-base sm:text-sm",
                  i === active && "bg-muted",
                )}
              >
                <span className="min-w-0">{o.label}</span>
                {o.value === value && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
