import React from "react";
import { Outlet } from "react-router-dom";
import OnboardingTour from "./OnboardingTour.jsx";
import useOnboarding from "../../hooks/useOnboarding.js";
import { useAuth } from "../../context/AuthContext.jsx";
import AIChat from "../ai/AIChat.jsx";
import CommandPalette from "./CommandPalette.jsx";
import ProviderBanner from "./ProviderBanner.jsx";
import Sidebar from "./Sidebar.jsx";
import TopBar from "./TopBar.jsx";

export default function Layout() {
  const tour = useOnboarding();
  const { user } = useAuth();
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [chatOpen, setChatOpen] = React.useState(false);
  const [chatQuery, setChatQuery] = React.useState("");
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  function openPalette() {
    setPaletteOpen(true);
  }

  function openChat(query = "") {
    setChatQuery(query);
    setChatOpen(true);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg2)" }}>
      {/* Mobile sidebar overlay */}
      <div
        className={`sidebar-overlay${sidebarOpen ? " active" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />
      <Sidebar open={sidebarOpen} />
      {/* Mobile hamburger toggle */}
      <button
        className="sidebar-toggle"
        onClick={() => setSidebarOpen(o => !o)}
        aria-label="Toggle navigation"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="4" width="12" height="1.5" rx="0.75" fill="currentColor"/>
          <rect x="2" y="7.25" width="12" height="1.5" rx="0.75" fill="currentColor"/>
          <rect x="2" y="10.5" width="12" height="1.5" rx="0.75" fill="currentColor"/>
        </svg>
      </button>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <TopBar onOpenPalette={openPalette} onOpenChat={openChat} />
        <ProviderBanner userId={user?.id} />
        <main style={{ flex: 1, padding: "28px 32px", overflow: "auto" }}>
          <Outlet />
        </main>
      </div>
      <OnboardingTour tour={tour} />
      <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} onOpenAIChat={openChat} />
      <AIChat isOpen={chatOpen} onClose={() => setChatOpen(false)} initialQuery={chatQuery} />
    </div>
  );
}
