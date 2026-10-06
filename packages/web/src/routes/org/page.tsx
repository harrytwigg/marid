import { lazy, Suspense, useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/lib/api";
import type { Employee, OrgData, OrgHierarchy } from "@/lib/api";
import { EmployeeDetail } from "@/components/org/employee-detail";
import { DepartmentPanel } from "@/components/org/department-panel";
import { useDepartments } from "@/hooks/use-departments";
import { isConfined, type DepartmentScopeWire } from "@/lib/department-api";
import { PageLayout } from "@/components/page-layout";
import { useSettings } from "@/routes/settings-provider";
import { PRODUCT_NAME } from "@/lib/brand"

const OrgMap = lazy(() =>
  import("@/components/org/org-map").then((m) => ({ default: m.OrgMap })),
);

const OrgMapFallback = (
  <div className="flex flex-col items-center justify-center h-full gap-[var(--space-3)] text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
    Loading map...
  </div>
);

export default function OrgPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [hierarchy, setHierarchy] = useState<OrgHierarchy | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The open employee lives in the URL so the panel is linkable and the Talk
  // orb can open one by name. The whole Employee is still what the panel wants,
  // so the name resolves against the loaded list.
  const [params, setParams] = useSearchParams();
  const selectedName = params.get("employee");
  // A department's panel is linkable the same way, and the two never show together.
  const selectedDepartment = params.get("department");
  const selected = useMemo(
    () => employees.find((e) => e.name === selectedName) ?? null,
    [employees, selectedName],
  );
  const openPanel = useCallback(
    (key: "employee" | "department" | null, value?: string) => {
      // Replace, not push: selecting a node never made a history entry before.
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("employee");
          next.delete("department");
          if (key && value) next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const setSelected = useCallback(
    (emp: Employee | null) => openPanel(emp ? "employee" : null, emp?.name),
    [openPanel],
  );
  const setDepartment = useCallback(
    (slug: string | null) => openPanel(slug ? "department" : null, slug ?? undefined),
    [openPanel],
  );
  const departments = useDepartments();
  const scopes = useMemo(() => {
    const confined: Record<string, DepartmentScopeWire> = {};
    for (const row of departments.data ?? []) if (isConfined(row.scope)) confined[row.slug] = row.scope;
    return confined;
  }, [departments.data]);
  const panelOpen = !!selected || !!selectedDepartment;
  const closeRef = useRef<HTMLButtonElement>(null);
  const { settings } = useSettings();

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getOrg()
      .then((data: OrgData) => {
        const coo: Employee = {
          name: (settings.portalName ?? "Jinn").toLowerCase(), // internal COO slug, not a display string
          displayName: settings.portalName ?? PRODUCT_NAME,
          department: "",
          rank: "executive",
          engine: "claude",
          model: "opus",
          persona: "COO and AI gateway daemon",
        };
        setEmployees([coo, ...data.employees]);
        setHierarchy(data.hierarchy);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [settings.portalName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Focus close button when panel opens
  useEffect(() => {
    if (panelOpen && closeRef.current) {
      closeRef.current.focus();
    }
  }, [panelOpen]);

  // ESC closes panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && panelOpen) {
        openPanel(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [panelOpen, openPanel]);

  const handleSelectEmployee = useCallback((emp: Employee) => {
    setSelected(emp);
  }, [setSelected]);

  // After an inline edit: reload the org (so the map re-parents / re-layouts on
  // a reportsTo change) and refresh the open panel with the saved employee.
  const handleEmployeeUpdated = useCallback(
    (emp: Employee) => {
      setEmployees((current) => current.map((e) => (e.name === emp.name ? emp : e)));
      loadData();
      setSelected(emp);
    },
    [loadData, setSelected],
  );

  if (error) {
    return (
      <PageLayout>
        <div className="flex flex-col items-center justify-center h-full gap-[var(--space-4)] text-[var(--text-tertiary)]">
          <div className="rounded-[var(--radius-md,12px)] px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-body)] text-[var(--system-red)]" style={{ background: "color-mix(in srgb, var(--system-red) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)" }}>
            Failed to load organization: {error}
          </div>
          <button
            onClick={loadData}
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md,12px)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-body)] font-[var(--weight-semibold)]" // jinn-shell: ok error retry, not page chrome
          >
            Retry
          </button>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <div className="flex h-full relative bg-[var(--bg)]">
        {/* Map (the only view) */}
        <div className="flex-1 h-full relative">
          {loading ? (
            <div className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">
              Loading...
            </div>
          ) : (
            <Suspense fallback={OrgMapFallback}>
              <OrgMap
                employees={employees}
                hierarchy={hierarchy}
                selectedName={selected?.name ?? null}
                onNodeClick={handleSelectEmployee}
                scopes={scopes}
                onDepartmentClick={setDepartment}
              />
            </Suspense>
          )}
        </div>

        {/* Mobile backdrop */}
        {panelOpen && (
          <div
            className="fixed inset-0 z-30 lg:hidden bg-black/50"
            onClick={() => openPanel(null)}
          />
        )}

        {/* Detail panel */}
        {panelOpen && (
          <div className="absolute top-0 right-0 bottom-0 left-0 sm:left-auto z-30">
            <div className="w-full sm:w-[420px] lg:w-[468px] xl:w-[520px] max-w-[100vw] h-full overflow-y-auto bg-[var(--bg)] flex flex-col shadow-[var(--shadow-overlay)]">
              {/* Close button */}
              <div className="sticky top-0 z-10 flex items-center justify-end px-[var(--space-4)] py-[var(--space-3)] bg-[var(--bg)]">
                <button
                  ref={closeRef}
                  onClick={() => openPanel(null)}
                  aria-label="Close detail panel"
                  className="w-[30px] h-[30px] rounded-full flex items-center justify-center bg-[var(--fill-tertiary)] text-[var(--text-secondary)] border-none cursor-pointer text-sm"
                >
                  &#x2715;
                </button>
              </div>

              {/* Employee or department detail */}
              <div className="px-[var(--space-4)] pb-[var(--space-6)]">
                {selected ? (
                  <EmployeeDetail
                    name={selected.name}
                    prefetched={selected.rank === "executive" ? selected : undefined}
                    onUpdated={handleEmployeeUpdated}
                  />
                ) : (
                  <DepartmentPanel
                    slug={selectedDepartment!}
                    onSelectEmployee={(name) => openPanel("employee", name)}
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </PageLayout>
  );
}
