import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { ClaudeProject, ClaudeSession } from "@/types";
import {
  preloadSessionFromCli,
  type PreloadDependencies,
  type SessionHint,
} from "./preloadSession";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

vi.mock("@/services/api", () => ({
  api: vi.fn(),
}));

// Mutable store state so individual tests can mutate `selectedSession` mid-scan
// to exercise the race guard.
const mockStoreState: {
  excludeSidechain: boolean;
  selectedSession: ClaudeSession | null;
} = {
  excludeSidechain: false,
  selectedSession: null,
};
vi.mock("@/store/useAppStore", () => ({
  useAppStore: {
    getState: () => mockStoreState,
  },
}));

import { api } from "@/services/api";

const UUID = "1265cd74-caa9-472e-b343-c4f44b5cf12c";

const project: ClaudeProject = {
  name: "demo",
  path: "/home/.claude/projects/demo",
  actual_path: "/home/user/demo",
  session_count: 1,
  message_count: 5,
  last_modified: "2026-04-15T00:00:00Z",
};

const session: ClaudeSession = {
  session_id: "demo-id",
  actual_session_id: UUID,
  file_path: "/home/.claude/projects/demo/1265cd74-caa9-472e-b343-c4f44b5cf12c.jsonl",
  project_name: "demo",
  message_count: 5,
  first_message_time: "2026-04-15T00:00:00Z",
  last_message_time: "2026-04-15T00:01:00Z",
  last_modified: "2026-04-15T00:01:00Z",
  has_tool_use: false,
  has_errors: false,
};

function makeDeps(overrides: Partial<PreloadDependencies> = {}): PreloadDependencies {
  return {
    getStartupSessionHint: vi.fn().mockResolvedValue(null),
    projects: [],
    selectProject: vi.fn().mockResolvedValue(undefined),
    selectSession: vi.fn().mockResolvedValue(undefined),
    t: (_k: string, fallback?: string) => fallback ?? "Session not found",
    ...overrides,
  };
}

describe("preloadSessionFromCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Reset mutable store state between tests.
    mockStoreState.excludeSidechain = false;
    mockStoreState.selectedSession = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("no-ops when there is no startup hint", async () => {
    const deps = makeDeps();
    const result = await preloadSessionFromCli(deps);
    expect(result).toEqual({ handled: false, matched: false });
    expect(deps.selectProject).not.toHaveBeenCalled();
    expect(deps.selectSession).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("opens a matching session across projects", async () => {
    vi.mocked(api).mockResolvedValueOnce([session] as unknown as never);
    const hint: SessionHint = { kind: "uuid", value: UUID };
    const deps = makeDeps({
      getStartupSessionHint: vi.fn().mockResolvedValue(hint),
      projects: [project],
    });

    const result = await preloadSessionFromCli(deps);

    expect(result).toEqual({ handled: true, matched: true });
    expect(api).toHaveBeenCalledWith("load_project_sessions", {
      projectPath: project.path,
      excludeSidechain: false,
    });
    expect(deps.selectProject).toHaveBeenCalledWith(project);
    expect(deps.selectSession).toHaveBeenCalledWith(session);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("matches a UUID prefix", async () => {
    vi.mocked(api).mockResolvedValueOnce([session] as unknown as never);
    const deps = makeDeps({
      getStartupSessionHint: vi.fn().mockResolvedValue({
        kind: "uuid",
        value: "1265cd74",
      } as SessionHint),
      projects: [project],
    });

    const result = await preloadSessionFromCli(deps);

    expect(result.matched).toBe(true);
    expect(deps.selectSession).toHaveBeenCalledWith(session);
  });

  it("shows a toast and reports matched=false when session is missing", async () => {
    vi.mocked(api).mockResolvedValueOnce([] as unknown as never);
    const deps = makeDeps({
      getStartupSessionHint: vi.fn().mockResolvedValue({
        kind: "uuid",
        value: UUID,
      } as SessionHint),
      projects: [project],
    });

    const result = await preloadSessionFromCli(deps);

    expect(result).toEqual({ handled: true, matched: false });
    expect(deps.selectProject).not.toHaveBeenCalled();
    expect(deps.selectSession).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Session not found");
  });

  it("tolerates individual project-load failures and keeps scanning", async () => {
    const projectA: ClaudeProject = { ...project, name: "a", path: "/a" };
    const projectB: ClaudeProject = { ...project, name: "b", path: "/b" };
    vi.mocked(api)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce([session] as unknown as never);

    const deps = makeDeps({
      getStartupSessionHint: vi.fn().mockResolvedValue({
        kind: "uuid",
        value: UUID,
      } as SessionHint),
      projects: [projectA, projectB],
    });

    const result = await preloadSessionFromCli(deps);

    expect(result.matched).toBe(true);
    expect(deps.selectProject).toHaveBeenCalledWith(projectB);
  });

  it("ignores unsupported hint kinds without crashing", async () => {
    const deps = makeDeps({
      getStartupSessionHint: vi.fn().mockResolvedValue({
        kind: "future",
        value: "irrelevant",
      } as unknown as SessionHint),
    });

    const result = await preloadSessionFromCli(deps);

    expect(result).toEqual({ handled: true, matched: false });
    expect(toast.error).not.toHaveBeenCalled();
  });

  // Race guard smoke test: if the user has already picked a session by the time
  // we enter the preload flow (e.g. hint resolves after project load), we do
  // not clobber their choice.
  it("skips select when user has already chosen a session before scan begins", async () => {
    mockStoreState.selectedSession = session;
    // The race guard fires at the top of the findSessionAcrossProjects loop,
    // so api is never called — no mock queue needed.
    const deps = makeDeps({
      getStartupSessionHint: vi.fn().mockResolvedValue({
        kind: "uuid",
        value: UUID,
      } as SessionHint),
      projects: [project],
    });

    const result = await preloadSessionFromCli(deps);

    expect(api).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: true, matched: false });
    expect(deps.selectProject).not.toHaveBeenCalled();
    expect(deps.selectSession).not.toHaveBeenCalled();
    // Not a "not found" toast either — user picked something.
    expect(toast.error).not.toHaveBeenCalled();
  });

  // Race simulation: user clicks a session while selectProject is awaiting.
  // Exercises the post-selectProject guard added between selectProject and
  // selectSession, not the loop-level guard.
  it("skips selectSession when selectedSession mutates during selectProject await", async () => {
    vi.mocked(api).mockResolvedValueOnce([session] as unknown as never);
    const selectProject = vi.fn().mockImplementation(async () => {
      // Simulate user picking a session while project loads.
      mockStoreState.selectedSession = session;
    });
    const selectSession = vi.fn().mockResolvedValue(undefined);

    const deps = makeDeps({
      getStartupSessionHint: vi.fn().mockResolvedValue({
        kind: "uuid",
        value: UUID,
      } as SessionHint),
      projects: [project],
      selectProject,
      selectSession,
    });

    const result = await preloadSessionFromCli(deps);

    expect(result).toEqual({ handled: true, matched: false });
    expect(selectProject).toHaveBeenCalledWith(project);
    // The CLI hint must not clobber the user's mid-flight manual selection.
    expect(selectSession).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  // Real race simulation: user clicks a session mid-scan. Exercises the
  // per-loop guard inside findSessionAcrossProjects, not just the final guard.
  it("aborts scan loop when selectedSession mutates mid-scan", async () => {
    const projectA: ClaudeProject = { ...project, name: "a", path: "/a" };
    const projectB: ClaudeProject = { ...project, name: "b", path: "/b" };
    const projectC: ClaudeProject = { ...project, name: "c", path: "/c" };
    let scanCount = 0;
    vi.mocked(api).mockImplementation(async () => {
      scanCount += 1;
      if (scanCount === 1) {
        // User clicks a session while project A's scan is in-flight.
        // The NEXT loop iteration should abort before hitting project B.
        mockStoreState.selectedSession = session;
      }
      return [] as unknown as never; // No match in any project
    });

    const deps = makeDeps({
      getStartupSessionHint: vi.fn().mockResolvedValue({
        kind: "uuid",
        value: UUID,
      } as SessionHint),
      projects: [projectA, projectB, projectC],
    });

    const result = await preloadSessionFromCli(deps);

    // Only project A was scanned. B and C were aborted by the race guard.
    expect(scanCount).toBe(1);
    expect(result).toEqual({ handled: true, matched: false });
    expect(deps.selectProject).not.toHaveBeenCalled();
    expect(deps.selectSession).not.toHaveBeenCalled();
    // Not a "not found" toast either — user picked something.
    expect(toast.error).not.toHaveBeenCalled();
  });
});
