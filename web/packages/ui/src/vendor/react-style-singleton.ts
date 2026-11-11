/**
 * A drop-in replacement for `react-style-singleton` (used by Radix's scroll lock through
 * react-remove-scroll-bar) that works under the host's Content-Security-Policy.
 *
 * The original injects a <style> element, which `style-src 'self'` blocks. This version adds the
 * same CSS through a constructable stylesheet (`document.adoptedStyleSheets`), which the policy
 * allows, so the scroll lock behaves as designed with no CSP violation.
 *
 * Apps alias the package to this file in vite.config.ts:
 *   resolve: { alias: { "react-style-singleton": ".../packages/ui/src/vendor/react-style-singleton.ts" } }
 */
import { useEffect } from "react";

interface Sheet {
  add(style: string): void;
  remove(): void;
}

export function stylesheetSingleton(): Sheet {
  let counter = 0;
  let sheet: CSSStyleSheet | null = null;
  return {
    add(style) {
      if (counter === 0 && typeof document !== "undefined" && "adoptedStyleSheets" in document) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(style);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      counter++;
    },
    remove() {
      counter--;
      if (!counter && sheet) {
        const done = sheet;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== done);
        sheet = null;
      }
    },
  };
}

export function styleHookSingleton(): (styles: string, isDynamic?: boolean) => void {
  const sheet = stylesheetSingleton();
  return (styles, isDynamic) => {
    // Same contract as the original: added on mount, removed on unmount, re-added only when dynamic.
    useEffect(() => {
      sheet.add(styles);
      return () => sheet.remove();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [styles && isDynamic]);
  };
}

export function styleSingleton(): (props: { styles: string; dynamic?: boolean }) => null {
  const useStyle = styleHookSingleton();
  return function Sheet({ styles, dynamic }) {
    useStyle(styles, dynamic);
    return null;
  };
}
