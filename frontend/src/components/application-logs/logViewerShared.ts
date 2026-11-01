import { keepPreviousData } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"

/** What a followed log is read with: again every 5 seconds, the lines of before staying, dimmed, while the next ones load. */
export const followedLogQuery = (follow: boolean) => ({ refetchInterval: follow ? 5_000 : (false as const), placeholderData: keepPreviousData })

/** The labels every log viewer of the console shares: the logs of the applications and of the sandboxes. */
export const useLogViewerLabels = () => {
    const { t } = useTranslation()
    return {
        actions: { refreshLabel: t("applicationLogs.refresh"), downloadLabel: t("applicationLogs.download") },
        viewer: {
            tailLabel: t("applicationLogs.tail"),
            tailOptionLabel: (count: number) => t("applicationLogs.tail_option", { count }),
            filterLabel: t("applicationLogs.filter"),
            filterPlaceholder: t("applicationLogs.filter_placeholder"),
            followLabel: t("applicationLogs.follow"),
            formatJsonLabel: t("applicationLogs.format_json"),
            formatJsonHint: t("applicationLogs.format_json_hint"),
            loadingLabel: t("common.loading")
        }
    }
}
