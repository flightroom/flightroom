import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import useProjectAiModels from "@/components/assistant/useProjectAiModels"
import { Badge } from "@/components/atoms"
import RepositoryLink from "@/components/RepositoryLink"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import type { Service } from "@/hooks/apiClients/useServicesApi"
import { isAiEditAvailable } from "@/pages/frontends/partials/components"
import FrontendBadge from "./FrontendBadge"
import RuntimeBadge from "./RuntimeBadge"

export const ServicesTable: React.FC<{ services: Service[]; frontends?: Frontend[] }> = ({ services, frontends = [] }) => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const assistantEnabled = useProjectAiModels().enabled

    return (
        <div className="overflow-hidden rounded-lg border-2 border-border bg-card">
            <Table>
                <TableHeader>
                    <TableRow className="bg-muted/60 hover:bg-muted/60">
                        <TableHead>{t("common.name")}</TableHead>
                        <TableHead>{t("services.slug")}</TableHead>
                        <TableHead>{t("services.runtime.label")}</TableHead>
                        <TableHead>{t("services.latest_version")}</TableHead>
                        <TableHead>{t("services.repository")}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {services.map(service => (
                        <TableRow key={service._id} className="cursor-pointer border-divider hover:bg-primary/5" onClick={() => navigate(`/service/${service._id}`)}>
                            <TableCell className="max-w-[16rem] truncate font-medium" title={service.name}>
                                {service.name}
                            </TableCell>
                            <TableCell className="max-w-[14rem] truncate text-foreground-secondary" title={service.slug}>
                                {service.slug}
                            </TableCell>
                            <TableCell>
                                <RuntimeBadge service={service} />
                            </TableCell>
                            <TableCell>{service.version ? <Badge>{service.version}</Badge> : <span className="text-foreground-secondary">—</span>}</TableCell>
                            <TableCell className="max-w-[16rem]">
                                <RepositoryLink repository={service.codeRepository} fallback={<span className="text-foreground-secondary">—</span>} />
                            </TableCell>
                        </TableRow>
                    ))}
                    {frontends.map(frontend => (
                        <TableRow
                            key={frontend._id}
                            className="cursor-pointer border-divider hover:bg-primary/5"
                            onClick={() => navigate(isAiEditAvailable(frontend, assistantEnabled) ? `/frontend/${frontend._id}` : `/frontend/${frontend._id}/settings`)}
                        >
                            <TableCell className="max-w-[16rem] truncate font-medium" title={frontend.name}>
                                {frontend.name}
                            </TableCell>
                            <TableCell className="max-w-[14rem] truncate text-foreground-secondary" title={frontend.slug}>
                                {frontend.slug}
                            </TableCell>
                            <TableCell>
                                <FrontendBadge />
                            </TableCell>
                            <TableCell>{frontend.version ? <Badge>{frontend.version}</Badge> : <span className="text-foreground-secondary">—</span>}</TableCell>
                            <TableCell className="max-w-[16rem]">
                                <RepositoryLink repository={frontend.codeRepository} fallback={<span className="text-foreground-secondary">—</span>} />
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    )
}

export default ServicesTable
