import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import ChatPage from "./pages/Chat";
import CalendarPage from "./pages/Calendar";
import PlanPage from "./pages/Plan";
import SmalltalkRecentPage from "./pages/SmalltalkRecent";
import SmalltalkProjectsPage from "./pages/SmalltalkProjects";
import SmalltalkProjectDetailPage from "./pages/SmalltalkProjectDetail";
import LoginPage from "./pages/Login";
import { AuthProvider, useAuth } from "./lib/auth";
import { ModeProvider } from "./lib/mode";

function AuthGate() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-dvh bg-bg text-text-muted flex items-center justify-center">
        <span className="text-sm">Lade…</span>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <ModeProvider userId={user.id}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/kalender" element={<CalendarPage />} />
          <Route path="/plan" element={<PlanPage />} />
          <Route path="/smalltalk/zuletzt" element={<SmalltalkRecentPage />} />
          <Route path="/smalltalk/projekte" element={<SmalltalkProjectsPage />} />
          <Route
            path="/smalltalk/projekte/:projectId"
            element={<SmalltalkProjectDetailPage />}
          />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Route>
      </Routes>
    </ModeProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </AuthProvider>
  );
}
