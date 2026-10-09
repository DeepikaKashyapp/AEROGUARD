import { useEffect, useState } from "react";
import AAR from "./pages/AAR.tsx";
import Briefing from "./pages/Briefing.tsx";
import Home from "./pages/Home.tsx";
import Instructor from "./pages/Instructor.tsx";
import Mission from "./pages/Mission.tsx";
import SummaryPage from "./pages/Summary.tsx";
import { DEMO } from "./api.ts";
import TraineePage from "./pages/Trainee.tsx";
import UnitPage from "./pages/Unit.tsx";

/** Tiny hash router: #/path/arg */
function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

export function go(path: string): void {
  if (!path) return;
  location.hash = path.startsWith("#") ? path : `#/${path.replace(/^\//, "")}`;
}

export default function App() {
  const [page, ...args] = useRoute();
  useEffect(() => window.scrollTo(0, 0), [page, args[0]]);
  if (page === "mission") return <Mission sessionId={args[0]} />;
  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M16 3 29 27H3z" fill="none" stroke="var(--accent)" strokeWidth="3" />
            <circle cx="16" cy="19" r="3" fill="var(--accent)" />
          </svg>
          AEROGUARD <small>counter-drone decision trainer</small>
        </a>
        <nav>
          <a href="#/" className={!page ? "on" : ""}>Trainees</a>
          <a href="#/unit" className={page === "unit" ? "on" : ""}>Unit dashboard</a>
          <a href="#/instructor" className={page === "instructor" ? "on" : ""}>Instructor</a>
        </nav>
      </header>
      {DEMO && (
        <div className="preview-bar">
          <b>Preview build.</b> Missions run live in your browser. Scoring, debriefs and the dashboards come from a recorded synthetic demo course;
          the full app runs them on its server (<code>./scripts/start.sh</code>).
        </div>
      )}
      {!page && <Home />}
      {page === "briefing" && <Briefing sessionId={args[0]} />}
      {page === "aar" && <AAR sessionId={args[0]} />}
      {page === "summary" && <SummaryPage sessionId={args[0]} />}
      {page === "trainee" && <TraineePage traineeId={args[0]} />}
      {page === "unit" && <UnitPage unitId={args[0]} />}
      {page === "instructor" && <Instructor />}
    </>
  );
}
