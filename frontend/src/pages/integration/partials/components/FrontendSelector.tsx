import { Select, SelectContent, SelectControl, SelectItem, SelectTrigger, SelectValue } from "@flightroom/design-system"
import React from "react"
import { useTranslation } from "react-i18next"
import { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { cn } from "@/utils/styleUtils"

interface FrontendSelectorProps {
    frontends: Frontend[]
    selectedFrontend: Frontend
    onSelect: (value: Frontend) => void
    className?: string
}

const FrontendSelector: React.FC<FrontendSelectorProps> = ({ frontends, selectedFrontend, onSelect, className = "" }) => {
    const { t } = useTranslation()

    return (
        <SelectControl label={t("integration.frontend_select_label")} id="frontend-select" className={cn("w-full max-w-80", className)}>
            <Select
                value={selectedFrontend?.slug}
                onValueChange={value => {
                    onSelect(frontends.find(mfe => mfe.slug === value))
                }}
            >
                <SelectTrigger className="w-full">
                    <SelectValue>
                        {selectedFrontend ? (
                            <div className="flex items-center gap-2">
                                <span>{selectedFrontend.name}</span>
                            </div>
                        ) : (
                            <span>{t("integration.frontend_select_placeholder")}</span>
                        )}
                    </SelectValue>
                </SelectTrigger>
                {frontends && (
                    <SelectContent>
                        {frontends.map(frontend => (
                            <SelectItem key={frontend.slug} value={frontend.slug}>
                                <div className="flex items-center gap-2">
                                    <span>{frontend.name}</span>
                                </div>
                            </SelectItem>
                        ))}
                    </SelectContent>
                )}
            </Select>
        </SelectControl>
    )
}

export default FrontendSelector
