import { useEffect, useState } from "react"
import type { FieldErrors, UseFormReturn } from "react-hook-form"
import { useLocation, useNavigate } from "react-router-dom"
import type { FormInput, FormValues } from "./frontendFormSchema"

/** Tabs that own validated fields, in the order they are shown: the first one with an error is the one we jump to. */
const FORM_TABS = ["general", "context", "hosting", "runtime"] as const

export type FormTab = (typeof FORM_TABS)[number] | "danger"

const isFormTab = (value: string | null): value is FormTab => Boolean(value && ([...FORM_TABS, "danger"] as string[]).includes(value))

const TAB_FIELDS: Record<FormTab, (keyof FormValues)[]> = {
    general: ["name", "slug", "description", "domainId", "kind", "version", "environmentVersions", "customVersion", "canary", "codeRepository"],
    context: ["context", "designSystem"],
    hosting: ["host"],
    runtime: [
        "port",
        "image",
        "livenessPath",
        "readinessPath",
        "docsPath",
        "openApiPath",
        "cpuRequest",
        "cpuLimit",
        "memoryRequest",
        "memoryLimit",
        "replicas",
        "environmentResources",
        "exposed",
        "exposurePath",
        "env",
        "configMapIds",
        "secretIds"
    ],
    danger: []
}

interface FrontendFormTabsInput {
    form: UseFormReturn<FormInput, unknown, FormValues>
    isEdit: boolean
    isDocker: boolean
}

/** The open tab of the form: from the link, kept in the hash, flagged when its fields fail, jumped to on an invalid submit. */
export const useFrontendFormTabs = ({ form, isEdit, isDocker }: FrontendFormTabsInput) => {
    const location = useLocation()
    const navigate = useNavigate()
    // `#hosting` opens a tab straight away.
    const linkedTab = location.hash.slice(1)
    const [activeTab, setActiveTab] = useState<FormTab>(isFormTab(linkedTab) ? linkedTab : "general")

    // The open tab is written in the hash, so a reload or a copied link lands on it
    const selectTab = (tab: FormTab) => {
        setActiveTab(tab)
        navigate({ search: location.search, hash: tab }, { replace: true })
    }

    // Another link followed while the page is open.
    useEffect(() => {
        if (isFormTab(linkedTab)) setActiveTab(linkedTab)
    }, [linkedTab])

    // A linked tab may not exist on this frontend (not of its kind, or not saved yet): fall back to the first one.
    const isTabShown = (tab: FormTab) => {
        if (tab === "danger") return isEdit
        if (tab === "hosting") return !isDocker
        if (tab === "runtime") return isDocker
        return true
    }
    const shownTab = isTabShown(activeTab) ? activeTab : "general"

    /** A tab is flagged when any of the fields it owns failed validation, so an error is never hidden behind an inactive tab. */
    const tabHasErrors = (tab: FormTab) => TAB_FIELDS[tab].some(field => Boolean(form.formState.errors[field]))

    const onInvalid = (errors: FieldErrors<FormInput>) => {
        const firstTabWithErrors = FORM_TABS.find(tab => isTabShown(tab) && TAB_FIELDS[tab].some(field => Boolean(errors[field])))
        if (firstTabWithErrors) selectTab(firstTabWithErrors)
    }

    return { shownTab, selectTab, tabHasErrors, onInvalid }
}
