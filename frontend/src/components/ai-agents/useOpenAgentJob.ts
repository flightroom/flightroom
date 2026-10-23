import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { jobErrorMessage } from "@/components/assistant/AssistantJobThread"
import useAiJobsApi from "@/hooks/apiClients/useAiJobsApi"
import useAssistantJobsStore from "@/store/useAssistantJobsStore"
import useAssistantStore from "@/store/useAssistantStore"
import useProjectStore from "@/store/useProjectStore"

/**
 * Opens an agent job in a tab of the assistant panel, and the panel with it. A working agent can be a
 * change request started on a frontend or service page, which has no job: `fallbackPath`, when given,
 * is where to go instead, quietly.
 */
const useOpenAgentJob = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const projectId = useProjectStore(state => state.project?._id)
    const aiJobsApi = useAiJobsApi()
    // The API client is a new object every render: the returned function stays the same for the canvas handlers.
    const latest = useRef({ aiJobsApi, navigate, projectId, t })
    useEffect(() => {
        latest.current = { aiJobsApi, navigate, projectId, t }
    })

    const openRef = useRef(async (jobId: string, fallbackPath?: string) => {
        const { aiJobsApi, navigate, projectId, t } = latest.current
        if (!projectId) return
        try {
            const job = await aiJobsApi.get(jobId, fallbackPath ? { silent: true } : { customErrorMessage: error => jobErrorMessage(t, error, "load") })
            useAssistantJobsStore.getState().openJob(projectId, job, true)
            useAssistantStore.getState().open()
        } catch {
            if (fallbackPath) navigate(fallbackPath)
        }
    })

    return openRef.current
}

export default useOpenAgentJob
