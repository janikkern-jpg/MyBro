import { useEffect, useRef } from "react";
import { Outlet } from "react-router-dom";
import Navigation from "./Navigation";
import SettingsPanel from "./SettingsPanel";
import logoUrl from "../assets/logo.svg";

export default function Layout() {
  const mobileHeaderRef = useRef<HTMLElement | null>(null);

  // Globaler Viewport-Tracker.
  // Hält drei CSS-Variablen am <html>-Element aktuell, die der Chat-
  // Container (siehe `.h-chat-shell` in index.css) braucht, um auf Mobil
  // beim Öffnen der Bildschirmtastatur nicht die ganze Seite mitscrollen
  // zu lassen:
  //   --vvh       : Höhe des sichtbaren Viewports (visualViewport.height)
  //   --vvo       : dessen offsetTop (iOS Pinch-Zoom / URL-Bar)
  //   --chat-top  : gemessene Höhe des mobilen Kopfbereichs
  // Zusätzlich toggeln wir `data-keyboard-open` an <html>, sobald sich
  // der visuelle Viewport signifikant kleiner als der Layout-Viewport
  // meldet – daran macht die CSS-Regel fest, dass die Bottom-Nav
  // ausgeblendet und der Reserve-Platz für sie entfernt wird.
  useEffect(() => {
    const doc = document.documentElement;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;

    const measureHeader = () => {
      const h = mobileHeaderRef.current?.offsetHeight ?? 0;
      // Auf Desktop ist der mobile Header via `md:hidden` display:none,
      // liefert also 0 – dann greift der Fallback in `.h-chat-shell`.
      if (h > 0) doc.style.setProperty("--chat-top", `${h}px`);
      else doc.style.removeProperty("--chat-top");
    };

    let raf = 0;
    const applyViewport = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (vv) {
          doc.style.setProperty("--vvh", `${vv.height}px`);
          doc.style.setProperty("--vvo", `${vv.offsetTop}px`);
          const kb = Math.max(
            0,
            window.innerHeight - vv.height - vv.offsetTop,
          );
          if (kb > 100) doc.setAttribute("data-keyboard-open", "true");
          else doc.removeAttribute("data-keyboard-open");
        }
        measureHeader();
      });
    };

    applyViewport();

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(applyViewport)
        : null;
    if (ro && mobileHeaderRef.current) ro.observe(mobileHeaderRef.current);

    window.addEventListener("resize", applyViewport);
    window.addEventListener("orientationchange", applyViewport);
    vv?.addEventListener("resize", applyViewport);
    vv?.addEventListener("scroll", applyViewport);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", applyViewport);
      window.removeEventListener("orientationchange", applyViewport);
      vv?.removeEventListener("resize", applyViewport);
      vv?.removeEventListener("scroll", applyViewport);
      doc.style.removeProperty("--vvh");
      doc.style.removeProperty("--vvo");
      doc.style.removeProperty("--chat-top");
      doc.removeAttribute("data-keyboard-open");
    };
  }, []);

  return (
    <div className="min-h-dvh bg-bg text-text md:flex">
      {/* Desktop Sidebar */}
      <Navigation variant="sidebar" />

      {/* Main content */}
      <main className="flex-1 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0 md:pl-0">
        {/* Mobile Top Header mit Logo */}
        <header
          ref={mobileHeaderRef}
          className="sticky top-0 z-30 flex items-center border-b border-border bg-bg-elevated/90 px-5 backdrop-blur md:hidden"
          style={{
            paddingTop: "max(0.5rem, env(safe-area-inset-top))",
            paddingBottom: "0.5rem",
          }}
        >
          <img src={logoUrl} alt="MyBro" className="h-10 w-auto" />
        </header>
        <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-6 md:py-12">
          <Outlet />
        </div>
      </main>

      {/* Mobile Bottom Tab Bar */}
      <Navigation variant="bottom" />

      {/* Einstellungen (Zahnrad oben rechts) */}
      <SettingsPanel />
    </div>
  );
}
