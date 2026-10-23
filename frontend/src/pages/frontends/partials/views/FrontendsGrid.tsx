import React from "react"
import { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import { AddNewFrontendCard, FrontendCard } from "@/pages/frontends/partials/components"

interface FrontendsGridProps {
    frontends: Frontend[]
    onAddNewFrontend: (parentId?: string) => void
}

export const FrontendsGrid: React.FC<FrontendsGridProps> = ({ frontends, onAddNewFrontend }) => {
    return (
        // `min(100%, 300px)` keeps the tracks from overflowing the page on narrow viewports.
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
            {frontends.map(mfe => (
                <FrontendCard key={mfe._id} mfe={mfe} />
            ))}
            <AddNewFrontendCard onAddNewFrontend={onAddNewFrontend} />
        </div>
    )
}

export default FrontendsGrid
