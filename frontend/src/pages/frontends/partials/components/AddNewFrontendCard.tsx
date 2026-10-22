import { AddTile } from "@flightroom/design-system"
import { Plus } from "lucide-react"
import { useTranslation } from "react-i18next"

interface AddNewFrontendCardProps {
    onAddNewFrontend: () => void
    className?: string
}

export const AddNewFrontendCard: React.FC<AddNewFrontendCardProps> = ({ onAddNewFrontend, className }) => {
    const { t } = useTranslation("platform")

    return <AddTile aspect="auto" onClick={() => onAddNewFrontend()} icon={<Plus />} label={t("frontend.add_new")} description={t("frontend.click_to_create")} className={className} />
}

export default AddNewFrontendCard
