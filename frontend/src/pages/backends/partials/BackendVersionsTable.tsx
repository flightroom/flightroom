import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyStateRow, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@flightroom/design-system"
import { Copy } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Badge, Button } from "@/components/atoms"
import type { BuiltBackend } from "@/hooks/apiClients/useBackendsApi"
import type { BuiltFrontend } from "@/hooks/apiClients/useFrontendsApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"

/** "sha256:0123456789ab…" is enough to tell two builds apart. */
const shortDigest = (digest?: string) => (digest ? digest.replace(/^sha256:/, "").slice(0, 12) : undefined)

/** The versions of a backend, or of a frontend served by its own container: both are images published by a pipeline. */
export const BackendVersionsTable: React.FC<{ versions: (BuiltBackend | BuiltFrontend)[] }> = ({ versions }) => {
    const { t } = useTranslation()
    const notifications = useToastNotificationStore()
    // Only when a pipeline sent one: an empty column on every row says nothing
    const showCommit = versions.some(built => built.commitSha)

    const copyImage = async (image: string) => {
        try {
            await navigator.clipboard.writeText(image)
            notifications.showSuccessNotification({ message: t("backends.versions.copied") })
        } catch {
            notifications.showErrorNotification({ message: t("backends.versions.copy_failed") })
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="mb-0">{t("backends.versions.title")}</CardTitle>
                <CardDescription>{t("backends.versions.description")}</CardDescription>
            </CardHeader>
            <CardContent className="pt-3">
                <div className="overflow-hidden rounded-lg border-2 border-border bg-card">
                    <Table>
                        <TableHeader>
                            <TableRow className="bg-muted/60 hover:bg-muted/60">
                                <TableHead>{t("backends.versions.version")}</TableHead>
                                <TableHead>{t("backends.versions.image")}</TableHead>
                                <TableHead>{t("backends.versions.digest")}</TableHead>
                                {showCommit && <TableHead>{t("backends.versions.commit")}</TableHead>}
                                <TableHead>{t("backends.versions.date")}</TableHead>
                                <TableHead className="text-right">{t("common.actions")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {versions.length > 0 ? (
                                versions.map(built => (
                                    <TableRow key={built._id ?? built.version} className="border-divider hover:bg-primary/5">
                                        <TableCell>
                                            <Badge>{built.version}</Badge>
                                        </TableCell>
                                        <TableCell className="max-w-[24rem] truncate font-mono text-xs" title={built.image}>
                                            {built.image ?? "—"}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-foreground-secondary" title={built.digest}>
                                            {shortDigest(built.digest) ?? "—"}
                                        </TableCell>
                                        {showCommit && (
                                            <TableCell className="font-mono text-xs text-foreground-secondary" title={built.commitSha}>
                                                {built.commitSha?.slice(0, 7) ?? "—"}
                                            </TableCell>
                                        )}
                                        <TableCell className="whitespace-nowrap text-foreground-secondary">{built.createdAt ? new Date(built.createdAt).toLocaleString() : "—"}</TableCell>
                                        <TableCell className="text-right">
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                disabled={!built.image}
                                                onClick={() => built.image && copyImage(built.image)}
                                                aria-label={t("backends.versions.copy_image")}
                                                title={t("backends.versions.copy_image")}
                                            >
                                                <Copy />
                                                {t("common.copy")}
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))
                            ) : (
                                <EmptyStateRow colSpan={5}>{t("backends.versions.empty")}</EmptyStateRow>
                            )}
                        </TableBody>
                    </Table>
                </div>
            </CardContent>
        </Card>
    )
}

export default BackendVersionsTable
