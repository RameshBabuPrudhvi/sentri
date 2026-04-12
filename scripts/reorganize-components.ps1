# scripts/reorganize-components.ps1
# Run from repo root: powershell -ExecutionPolicy Bypass -File scripts/reorganize-components.ps1
# After running: cd frontend && npm run build
# Then delete scripts/ folder before committing.

$ErrorActionPreference = "Stop"
$COMP = "frontend/src/components"
$PAGES = "frontend/src/pages"

function Replace-InFile($Path, $Old, $New) {
    $content = Get-Content $Path -Raw
    if ($content.Contains($Old)) {
        $content = $content.Replace($Old, $New)
        Set-Content $Path $content -NoNewline
        Write-Host "  OK: $Path" -ForegroundColor Green
    } else {
        Write-Host "  SKIP: $Path" -ForegroundColor Yellow
    }
}

Write-Host "`n=== Creating subdirectories ===" -ForegroundColor Cyan
@("ai","charts","crawl","generate","layout","run","shared") | ForEach-Object {
    New-Item -ItemType Directory -Force -Path "$COMP/$_" | Out-Null
}

Write-Host "`n=== Moving files ===" -ForegroundColor Cyan
$moves = @{
    "ai"       = @("AIChat.jsx","AiFixPanel.jsx","LLMStreamPanel.jsx","DiffView.jsx")
    "charts"   = @("PassFailChart.jsx","SparklineChart.jsx","StackedBar.jsx","PassRateBar.jsx")
    "crawl"    = @("CrawlView.jsx","CrawlProjectModal.jsx","SiteGraph.jsx","CrawlDialsPanel.jsx")
    "generate" = @("GenerateView.jsx","GenerateTestModal.jsx","GenerationSuccessBanner.jsx","ExploreModePicker.jsx")
    "layout"   = @("Layout.jsx","AppLogo.jsx","CommandPalette.jsx","ProtectedRoute.jsx","OnboardingTour.jsx","ProviderBadge.jsx","ErrorBoundary.jsx")
    "run"      = @("RunSidebar.jsx","RunRegressionModal.jsx","LiveBrowserView.jsx","TestRunView.jsx","StepResultsView.jsx","ExecutionTimeline.jsx","OutcomeBanner.jsx","OverlayCanvas.jsx","HealingTimeline.jsx","PipelineCard.jsx","ActivityLogCard.jsx")
    "shared"   = @("ModalShell.jsx","StatCard.jsx","Tooltip.jsx","StatusBadge.jsx","TestBadges.jsx","AgentTag.jsx","Collapsible.jsx","TestDials.jsx","DeleteProjectModal.jsx","TablePagination.jsx")
}
foreach ($folder in $moves.Keys) {
    foreach ($file in $moves[$folder]) {
        if (Test-Path "$COMP/$file") {
            Move-Item "$COMP/$file" "$COMP/$folder/"
            Write-Host "  $folder/$file"
        }
    }
}
Remove-Item "$COMP/CompletionCTA.jsx" -ErrorAction SilentlyContinue

Write-Host "`n=== Fixing intra-component imports ===" -ForegroundColor Cyan
Replace-InFile "$COMP/layout/Layout.jsx" 'import AIChat from "./AIChat.jsx"' 'import AIChat from "../ai/AIChat.jsx"'
Replace-InFile "$COMP/crawl/CrawlView.jsx" 'import PipelineCard from "./PipelineCard.jsx"' 'import PipelineCard from "../run/PipelineCard.jsx"'
Replace-InFile "$COMP/crawl/CrawlView.jsx" 'import GenerationSuccessBanner from "./GenerationSuccessBanner.jsx"' 'import GenerationSuccessBanner from "../generate/GenerationSuccessBanner.jsx"'
Replace-InFile "$COMP/crawl/CrawlView.jsx" 'import ActivityLogCard from "./ActivityLogCard.jsx"' 'import ActivityLogCard from "../run/ActivityLogCard.jsx"'
Replace-InFile "$COMP/crawl/CrawlView.jsx" 'import RunSidebar from "./RunSidebar.jsx"' 'import RunSidebar from "../run/RunSidebar.jsx"'
Replace-InFile "$COMP/generate/GenerateView.jsx" 'import LLMStreamPanel from "./LLMStreamPanel.jsx"' 'import LLMStreamPanel from "../ai/LLMStreamPanel.jsx"'
Replace-InFile "$COMP/generate/GenerateView.jsx" 'import PipelineCard from "./PipelineCard.jsx"' 'import PipelineCard from "../run/PipelineCard.jsx"'
Replace-InFile "$COMP/generate/GenerateView.jsx" 'import ActivityLogCard from "./ActivityLogCard.jsx"' 'import ActivityLogCard from "../run/ActivityLogCard.jsx"'
Replace-InFile "$COMP/generate/GenerateView.jsx" 'import RunSidebar from "./RunSidebar.jsx"' 'import RunSidebar from "../run/RunSidebar.jsx"'
Replace-InFile "$COMP/generate/GenerateTestModal.jsx" 'import ModalShell from "./ModalShell.jsx"' 'import ModalShell from "../shared/ModalShell.jsx"'
Replace-InFile "$COMP/generate/GenerateTestModal.jsx" 'import TestDials from "./TestDials.jsx"' 'import TestDials from "../shared/TestDials.jsx"'
Replace-InFile "$COMP/generate/GenerationSuccessBanner.jsx" 'import OutcomeBanner from "./OutcomeBanner.jsx"' 'import OutcomeBanner from "../run/OutcomeBanner.jsx"'
Replace-InFile "$COMP/crawl/CrawlProjectModal.jsx" 'import ModalShell from "./ModalShell.jsx"' 'import ModalShell from "../shared/ModalShell.jsx"'
Replace-InFile "$COMP/crawl/CrawlProjectModal.jsx" 'import ExploreModePicker from "./ExploreModePicker.jsx"' 'import ExploreModePicker from "../generate/ExploreModePicker.jsx"'
Replace-InFile "$COMP/crawl/CrawlDialsPanel.jsx" 'import TestDials from "./TestDials.jsx"' 'import TestDials from "../shared/TestDials.jsx"'
Replace-InFile "$COMP/run/RunRegressionModal.jsx" 'import ModalShell from "./ModalShell.jsx"' 'import ModalShell from "../shared/ModalShell.jsx"'

Write-Host "`n=== Fixing page imports ===" -ForegroundColor Cyan
Replace-InFile "frontend/src/App.jsx" 'import ProtectedRoute from "./components/ProtectedRoute.jsx"' 'import ProtectedRoute from "./components/layout/ProtectedRoute.jsx"'
Replace-InFile "frontend/src/App.jsx" 'import Layout from "./components/Layout.jsx"' 'import Layout from "./components/layout/Layout.jsx"'
Replace-InFile "frontend/src/App.jsx" 'import ErrorBoundary from "./components/ErrorBoundary.jsx"' 'import ErrorBoundary from "./components/layout/ErrorBoundary.jsx"'
Replace-InFile "$PAGES/Dashboard.jsx" 'import AgentTag from "../components/AgentTag.jsx"' 'import AgentTag from "../components/shared/AgentTag.jsx"'
Replace-InFile "$PAGES/Dashboard.jsx" 'import StatCard from "../components/StatCard.jsx"' 'import StatCard from "../components/shared/StatCard.jsx"'
Replace-InFile "$PAGES/Dashboard.jsx" 'import PassFailChart from "../components/PassFailChart.jsx"' 'import PassFailChart from "../components/charts/PassFailChart.jsx"'
Replace-InFile "$PAGES/Dashboard.jsx" 'import SparklineChart from "../components/SparklineChart.jsx"' 'import SparklineChart from "../components/charts/SparklineChart.jsx"'
Replace-InFile "$PAGES/Dashboard.jsx" 'import StackedBar from "../components/StackedBar.jsx"' 'import StackedBar from "../components/charts/StackedBar.jsx"'
Replace-InFile "$PAGES/Dashboard.jsx" 'import AppLogo from "../components/AppLogo.jsx"' 'import AppLogo from "../components/layout/AppLogo.jsx"'
Replace-InFile "$PAGES/Tests.jsx" 'import GenerateTestModal from "../components/GenerateTestModal.jsx"' 'import GenerateTestModal from "../components/generate/GenerateTestModal.jsx"'
Replace-InFile "$PAGES/Tests.jsx" 'import CrawlProjectModal from "../components/CrawlProjectModal.jsx"' 'import CrawlProjectModal from "../components/crawl/CrawlProjectModal.jsx"'
Replace-InFile "$PAGES/Tests.jsx" 'import AgentTag from "../components/AgentTag.jsx"' 'import AgentTag from "../components/shared/AgentTag.jsx"'
Replace-InFile "$PAGES/Tests.jsx" 'import RunRegressionModal from "../components/RunRegressionModal.jsx"' 'import RunRegressionModal from "../components/run/RunRegressionModal.jsx"'
Replace-InFile "$PAGES/Tests.jsx" 'import ModalShell from "../components/ModalShell.jsx"' 'import ModalShell from "../components/shared/ModalShell.jsx"'
Replace-InFile "$PAGES/Tests.jsx" 'from "../components/TestBadges.jsx"' 'from "../components/shared/TestBadges.jsx"'
Replace-InFile "$PAGES/Tests.jsx" 'import TablePagination from "../components/TablePagination.jsx"' 'import TablePagination from "../components/shared/TablePagination.jsx"'
Replace-InFile "$PAGES/ProjectDetail.jsx" 'import AgentTag from "../components/AgentTag.jsx"' 'import AgentTag from "../components/shared/AgentTag.jsx"'
Replace-InFile "$PAGES/ProjectDetail.jsx" 'import ModalShell from "../components/ModalShell.jsx"' 'import ModalShell from "../components/shared/ModalShell.jsx"'
Replace-InFile "$PAGES/ProjectDetail.jsx" 'from "../components/TestBadges.jsx"' 'from "../components/shared/TestBadges.jsx"'
Replace-InFile "$PAGES/ProjectDetail.jsx" 'import TablePagination from "../components/TablePagination.jsx"' 'import TablePagination from "../components/shared/TablePagination.jsx"'
Replace-InFile "$PAGES/RunDetail.jsx" 'import CrawlView from "../components/CrawlView"' 'import CrawlView from "../components/crawl/CrawlView"'
Replace-InFile "$PAGES/RunDetail.jsx" 'import GenerateView from "../components/GenerateView"' 'import GenerateView from "../components/generate/GenerateView"'
Replace-InFile "$PAGES/RunDetail.jsx" 'import TestRunView from "../components/TestRunView"' 'import TestRunView from "../components/run/TestRunView"'
Replace-InFile "$PAGES/RunDetail.jsx" 'import AgentTag from "../components/AgentTag.jsx"' 'import AgentTag from "../components/shared/AgentTag.jsx"'
Replace-InFile "$PAGES/TestDetail.jsx" 'import("../components/DiffView.jsx")' 'import("../components/ai/DiffView.jsx")'
Replace-InFile "$PAGES/TestDetail.jsx" 'import("../components/AiFixPanel.jsx")' 'import("../components/ai/AiFixPanel.jsx")'
Replace-InFile "$PAGES/TestDetail.jsx" 'from "../components/TestBadges.jsx"' 'from "../components/shared/TestBadges.jsx"'
Replace-InFile "$PAGES/TestDetail.jsx" 'import TablePagination, { PAGE_SIZE } from "../components/TablePagination.jsx"' 'import TablePagination, { PAGE_SIZE } from "../components/shared/TablePagination.jsx"'
Replace-InFile "$PAGES/Reports.jsx" 'import StatCard from "../components/StatCard"' 'import StatCard from "../components/shared/StatCard"'
Replace-InFile "$PAGES/Reports.jsx" 'import StatusBadge from "../components/StatusBadge"' 'import StatusBadge from "../components/shared/StatusBadge"'
Replace-InFile "$PAGES/Reports.jsx" 'import PassFailChart from "../components/PassFailChart"' 'import PassFailChart from "../components/charts/PassFailChart"'
Replace-InFile "$PAGES/Reports.jsx" 'import PassRateBar from "../components/PassRateBar"' 'import PassRateBar from "../components/charts/PassRateBar"'
Replace-InFile "$PAGES/Reports.jsx" 'import TablePagination, { PAGE_SIZE } from "../components/TablePagination.jsx"' 'import TablePagination, { PAGE_SIZE } from "../components/shared/TablePagination.jsx"'
Replace-InFile "$PAGES/Applications.jsx" 'import PassRateBar from "../components/PassRateBar"' 'import PassRateBar from "../components/charts/PassRateBar"'
Replace-InFile "$PAGES/Applications.jsx" 'import DeleteProjectModal from "../components/DeleteProjectModal.jsx"' 'import DeleteProjectModal from "../components/shared/DeleteProjectModal.jsx"'
Replace-InFile "$PAGES/Runs.jsx" 'import StatusBadge from "../components/StatusBadge"' 'import StatusBadge from "../components/shared/StatusBadge"'
Replace-InFile "$PAGES/Runs.jsx" 'import RunRegressionModal from "../components/RunRegressionModal.jsx"' 'import RunRegressionModal from "../components/run/RunRegressionModal.jsx"'
Replace-InFile "$PAGES/Runs.jsx" 'import TablePagination, { PAGE_SIZE } from "../components/TablePagination.jsx"' 'import TablePagination, { PAGE_SIZE } from "../components/shared/TablePagination.jsx"'
Replace-InFile "$PAGES/Login.jsx" 'import AppLogo from "../components/AppLogo.jsx"' 'import AppLogo from "../components/layout/AppLogo.jsx"'
Replace-InFile "$PAGES/ForgotPassword.jsx" 'import AppLogo from "../components/AppLogo.jsx"' 'import AppLogo from "../components/layout/AppLogo.jsx"'
Replace-InFile "$PAGES/Settings.jsx" 'import { invalidateConfigCache } from "../components/ProviderBadge.jsx"' 'import { invalidateConfigCache } from "../components/layout/ProviderBadge.jsx"'

Write-Host "`n=== Done! ===" -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  1. cd frontend && npm run build"
Write-Host "  2. npm run dev (spot-check)"
Write-Host "  3. Remove this script: Remove-Item scripts/ -Recurse"
Write-Host "  4. git add -A && git commit"
