import { Outlet } from "react-router-dom";
import Navigation from "./Navigation";
import SettingsPanel from "./SettingsPanel";
import logoUrl from "../assets/logo.svg";

export default function Layout() {
  return (
    <div className="min-h-dvh bg-bg text-text md:flex">
      {/* Desktop Sidebar */}
      <Navigation variant="sidebar" />

      {/* Main content */}
      <main className="flex-1 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0 md:pl-0">
        {/* Mobile Top Header mit Logo */}
        <header
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
