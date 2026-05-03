/** @module components/shared — Generic reusable UI primitives. */
export { default as ModalShell } from "./ModalShell.jsx";
export { default as StatCard } from "./StatCard.jsx";
export { default as Tooltip } from "./Tooltip.jsx";
export { default as StatusBadge } from "./StatusBadge.jsx";
export { default as AgentTag } from "./AgentTag.jsx";
export { default as Collapsible } from "./Collapsible.jsx";
// `TestDials.jsx` was replaced by `frontend/src/components/test/TestConfig.jsx`.
// Direct importers of `countActiveDials` should pull it from
// `frontend/src/utils/testDialsStorage.js` instead.
export { default as DeleteProjectModal } from "./DeleteProjectModal.jsx";
export { default as TablePagination, PAGE_SIZE } from "./TablePagination.jsx";
export { StatusBadge as TestStatusBadge, ReviewBadge, ScenarioBadges } from "./TestBadges.jsx";
export { default as BrowserBadge } from "./BrowserBadge.jsx";
export { default as CopyButton } from "./CopyButton.jsx";

