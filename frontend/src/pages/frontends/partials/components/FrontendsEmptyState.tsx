import { EmptyState } from "@flightroom/design-system"
import { CirclePlus, DownloadCloud, PackageOpen, SearchX } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"

interface FrontendsEmptyStateProps {
    /** `empty` when the project has no frontend at all, `no-results` when the search filtered everything out. */
    variant: "empty" | "no-results"
    searchTerm?: string
    onAddNewFrontend?: () => void
    /** Only provided when the project has at least one code repository connection to import from. */
    onImportRepositories?: () => void
    onResetFilters?: () => void
    /** Replaces the default no-results text, e.g. when a filter other than the search emptied the list */
    noResultsDescription?: string
}

export const FrontendsEmptyState: React.FC<FrontendsEmptyStateProps> = ({ variant, searchTerm, onAddNewFrontend, onImportRepositories, onResetFilters, noResultsDescription }) => {
    const { t } = useTranslation()

    const isNoResults = variant === "no-results"

    return (
        <EmptyState
            variant="outlined"
            size="lg"
            tone="primary"
            icon={isNoResults ? <SearchX /> : <PackageOpen />}
            title={isNoResults ? t("frontend.dashboard.noResultsTitle") : t("frontend.no_frontends_found")}
            description={isNoResults ? (noResultsDescription ?? t("frontend.dashboard.noResultsDescription", { searchTerm })) : t("frontend.no_frontends_found_description")}
            actions={
                isNoResults ? (
                    <Button variant="secondary" onClick={onResetFilters}>
                        {t("domains.filter.reset")}
                    </Button>
                ) : (
                    <>
                        <Button onClick={onAddNewFrontend}>
                            <CirclePlus />
                            {t("frontend.add_new")}
                        </Button>
                        {onImportRepositories && (
                            <Button variant="secondary" onClick={onImportRepositories}>
                                <DownloadCloud />
                                {t("frontend.import.action")}
                            </Button>
                        )}
                    </>
                )
            }
        />
    )
}

export default FrontendsEmptyState
