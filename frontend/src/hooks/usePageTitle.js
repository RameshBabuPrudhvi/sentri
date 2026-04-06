/**
 * @module hooks/usePageTitle
 * @description Sets `document.title` on mount and restores the default on unmount.
 *
 * @param {string} title - Page-specific title (e.g. "Dashboard").
 *                         Rendered as "title — Sentri".
 *
 * @example
 * usePageTitle("Dashboard");
 * // document.title → "Dashboard — Sentri"
 */

import { useEffect } from "react";

const APP_NAME = "Sentri";

export default function usePageTitle(title) {
  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} — ${APP_NAME}` : APP_NAME;
    return () => { document.title = prev; };
  }, [title]);
}
