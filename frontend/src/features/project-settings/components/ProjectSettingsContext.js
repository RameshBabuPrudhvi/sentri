import { createContext, useContext } from "react";

/**
 * ProjectSettingsContext — provides the loaded project + role / toast
 * helpers to every section component without prop-drilling through the
 * layout → Outlet → section chain.
 *
 * Provided by `ProjectSettingsLayout`; consumed by every section under
 * `features/project-settings/sections/*`.
 *
 * Shape:
 *   {
 *     project: Project,                                  // hydrated from useQuery(getProject)
 *     canEdit: boolean,                                  // qa_lead+ on the workspace
 *     onToast: (message: string, type?: "success"|"error"|"info") => void,  // wraps useToast()
 *     refresh: () => Promise<void>,                      // re-fetch the project after a save
 *   }
 *
 * Sections call `useProjectSettings()` to read these. The context
 * deliberately mirrors the prop signature the existing panel components
 * (`QualityGatesPanel`, `AutoApprovalPanel`, etc.) already accept, so
 * each section file becomes a thin pass-through.
 */
export const ProjectSettingsContext = createContext(null);

export function useProjectSettings() {
  const ctx = useContext(ProjectSettingsContext);
  if (!ctx) {
    throw new Error(
      "useProjectSettings must be used inside <ProjectSettingsLayout>",
    );
  }
  return ctx;
}
