// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  ChevronDown,
  LogOut,
  Settings2,
  User,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useSession } from "@/lib/session";
import { abortAllStreams } from "@/lib/ai";
import { useAccountProfile } from "@/lib/profile-store";
import { navigate } from "@/lib/navigate";
import { avatarFor, shortName } from "@/lib/profile";
import { cn } from "@/lib/utils";

/**
 * The header's account entry.
 *
 * Two states, one component:
 *
 *   - signed out: `登录` stays a plain link (the thing people click to sign
 *     in should not require a menu first), with a small chevron beside it
 *     for 注册 / 设置. The chevron is what keeps BYOK reachable without an
 *     account without turning the header into four separate controls.
 *   - signed in: avatar + a few characters, opening 我的 / 设置 / 退出登录.
 *
 * The menu is the transitions.dev `menu-dropdown`: `t-dropdown` grows from
 * the trigger's top-right corner, 250ms in and 150ms out. It stays mounted
 * so the open transition has a resting state to animate from.
 */
export default function TopBarMenu({ showLibrary = true }: { showLibrary?: boolean }) {
  const status = useSession((s) => s.status);
  const user = useSession((s) => s.user);
  const signOut = useSession((s) => s.signOut);

  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const signedIn = status === "authed" && user !== null;
  const profile = useAccountProfile(signedIn ? user?.id : null);

  function clearCloseTimer() {
    if (closeTimer.current !== undefined) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    }
  }

  function openMenu() {
    clearCloseTimer();
    setClosing(false);
    setOpen(true);
    requestAnimationFrame(() => focusItem(0));
  }

  function closeMenu(returnFocus = true) {
    if (!open && !closing) return;
    setOpen(false);
    setClosing(true);
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => {
      setClosing(false);
      closeTimer.current = undefined;
    }, 150);
    if (returnFocus) triggerRef.current?.focus();
  }

  function focusItem(index: number) {
    const items = menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-item]");
    if (!items || items.length === 0) return;
    const next = items[(index + items.length) % items.length];
    next.focus();
  }

  function currentItemIndex(): number {
    const items = menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-item]");
    if (!items) return -1;
    return Array.from(items).indexOf(document.activeElement as HTMLElement);
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === "Tab") {
      closeMenu(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(currentItemIndex() + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(currentItemIndex() - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      const items = menuRef.current?.querySelectorAll("[data-menu-item]");
      focusItem((items?.length ?? 1) - 1);
    }
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) openMenu();
      else focusItem(0);
    } else if (event.key === "Escape") {
      closeMenu();
    }
  }

  useEffect(() => () => clearCloseTimer(), []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) closeMenu(false);
    };
    // A route change the menu did not initiate (browser back, a deep link)
    // should not leave it floating over a different page.
    const onHashChange = () => closeMenu(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("hashchange", onHashChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function onNavigate(event: MouseEvent, href: string) {
    event.preventDefault();
    closeMenu(false);
    navigate(href);
  }

  async function onSignOut() {
    closeMenu(false);
    // Same local half the account page used to run before signing out: an
    // in-flight AI stream must not outlive the session that started it.
    abortAllStreams();
    await signOut();
    navigate("#/");
  }

  const avatar = signedIn
    ? avatarFor({ id: user?.id, email: user?.email })
    : null;
  const name = signedIn
    ? shortName({
        id: user?.id,
        email: user?.email,
        nickname: profile?.name ?? null,
      })
    : "";

  return (
    <div className="flex items-center gap-3">
      {showLibrary ? (
        <a
          href="#/library"
          data-testid="library-link"
          className="text-sm text-gloss-textDim transition-colors hover:text-gloss-text"
        >
          我的文章
        </a>
      ) : null}

      {status === "loading" ? null : signedIn ? (
        <div ref={wrapRef} className="relative">
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => (open ? closeMenu() : openMenu())}
            onKeyDown={onTriggerKeyDown}
            className="flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-1.5 text-sm text-gloss-textDim transition-colors hover:bg-gloss-text/[0.05] hover:text-gloss-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gloss-accent/40"
          >
            <img
              src={avatar ?? undefined}
              alt=""
              className="size-6 rounded-full bg-gloss-surface2"
            />
            <span className="max-w-[5.5rem] truncate">{name}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3.5 transition-transform duration-200 ease-out",
                open && "rotate-180",
              )}
            />
          </button>

          <MenuSurface
            id={menuId}
            menuRef={menuRef}
            open={open}
            closing={closing}
            onKeyDown={onMenuKeyDown}
            widthClass="w-44"
          >
            <MenuLink
              href="#/account"
              icon={User}
              label="我的"
              onNavigate={onNavigate}
            />
            <MenuLink
              href="#/settings"
              icon={Settings2}
              label="设置"
              onNavigate={onNavigate}
            />
            <div role="separator" className="my-1 h-px bg-gloss-border" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-menu-item
              onClick={onSignOut}
              className={menuItemClass}
            >
              <LogOut className="size-3.5" aria-hidden="true" />
              退出登录
            </button>
          </MenuSurface>
        </div>
      ) : (
        <div ref={wrapRef} className="relative flex items-center">
          <a
            href="#/login"
            className="text-sm text-gloss-textDim transition-colors hover:text-gloss-text"
          >
            登录
          </a>
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label="账号菜单"
            onClick={() => (open ? closeMenu() : openMenu())}
            onKeyDown={onTriggerKeyDown}
            className="ml-0.5 grid size-6 place-items-center rounded-md text-gloss-textDim transition-colors hover:bg-gloss-text/[0.05] hover:text-gloss-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gloss-accent/40"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3.5 transition-transform duration-200 ease-out",
                open && "rotate-180",
              )}
            />
          </button>

          <MenuSurface
            id={menuId}
            menuRef={menuRef}
            open={open}
            closing={closing}
            onKeyDown={onMenuKeyDown}
            widthClass="w-40"
          >
            <MenuLink
              href="#/register"
              icon={UserPlus}
              label="注册"
              onNavigate={onNavigate}
            />
            <MenuLink
              href="#/settings"
              icon={Settings2}
              label="设置"
              onNavigate={onNavigate}
            />
          </MenuSurface>
        </div>
      )}
    </div>
  );
}

const menuItemClass =
  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-gloss-textDim transition-colors hover:bg-gloss-text/[0.06] hover:text-gloss-text focus:bg-gloss-text/[0.06] focus:text-gloss-text focus:outline-none";

function MenuSurface({
  id,
  menuRef,
  open,
  closing,
  onKeyDown,
  widthClass,
  children,
}: {
  id: string;
  menuRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  closing: boolean;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  widthClass: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label="账号菜单"
      aria-hidden={!open}
      inert={!open}
      data-origin="top-right"
      onKeyDown={onKeyDown}
      className={cn(
        "t-dropdown absolute right-0 top-[calc(100%+8px)] z-[65] rounded-xl border border-gloss-border bg-gloss-surface p-1 shadow-[0_22px_50px_-18px_rgb(0_0_0/0.6)]",
        widthClass,
        open && "is-open",
        closing && "is-closing",
      )}
    >
      {children}
    </div>
  );
}

function MenuLink({
  href,
  icon: Icon,
  label,
  onNavigate,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  onNavigate: (event: MouseEvent, href: string) => void;
}) {
  return (
    <a
      href={href}
      role="menuitem"
      tabIndex={-1}
      data-menu-item
      onClick={(event) => onNavigate(event, href)}
      className={menuItemClass}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </a>
  );
}
