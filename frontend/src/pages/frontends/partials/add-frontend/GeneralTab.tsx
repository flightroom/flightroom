import { Alert, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@flightroom/design-system"
import { useFormContext } from "react-hook-form"
import { useTranslation } from "react-i18next"
import TextareaField from "@/components/input/TextareaField.rhf"
import TextField from "@/components/input/TextField.rhf"
import type { ICodeRepository } from "@/hooks/apiClients/useCodeRepositoriesApi"
import type { Frontend } from "@/hooks/apiClients/useFrontendsApi"
import DomainSection from "@/pages/domains/partials/DomainSection"
import { CodeRepositorySection, FrontendKindField, ReleaseSection } from "@/pages/frontends/partials/components"
import type { FormInput } from "./frontendFormSchema"

interface GeneralTabProps {
    id?: string
    isEdit: boolean
    isDocker: boolean
    template: string | null
    parentId: string | null
    frontend?: Frontend
    versions?: string[]
    repositories: ICodeRepository[]
}

/** Its domain and release, what it is called and of what kind, and its code repository */
export const GeneralTab: React.FC<GeneralTabProps> = ({ id, isEdit, isDocker, template, parentId, frontend, versions, repositories }) => {
    const { t } = useTranslation()
    const form = useFormContext<FormInput>()
    const hasRepositories = Boolean(repositories && repositories.length > 0)

    return (
        <div className="flex flex-col gap-6">
            {/* Domain and release first, side by side: what it belongs to and what is served, at a glance */}
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <DomainSection />
                <ReleaseSection isEdit={isEdit} versions={versions} container={isDocker} />
            </div>
            <Card>
                <CardHeader>
                    <CardTitle className="mb-0">{t("frontend.general_information")}</CardTitle>
                    <CardDescription>{t("frontend.general_information_description")}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 pt-3">
                    <FrontendKindField disabled={Boolean(parentId)} dockerDisabled={Boolean(frontend?.parentIds?.length)} />
                    {/* The templates scaffold a pipeline that uploads a bundle, which a DOCKER does not take */}
                    {isDocker && template && !isEdit && (
                        <Alert>
                            <AlertDescription>{t("frontend.kind.template_pipeline_hint")}</AlertDescription>
                        </Alert>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                        <TextField
                            name="name"
                            label={t("frontend.name")}
                            placeholder={t("frontend.name_placeholder")}
                            textTransform={value => value.replace("  ", " ")}
                            required
                            onChange={e => {
                                const slug = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "-")
                                if (!isEdit) {
                                    form.setValue("slug", slug)
                                    form.setValue("codeRepository.createData.name", slug)
                                }
                            }}
                            containerClassName="flex-[1_1_240px]"
                        />
                        <TextField name="slug" disabled={isEdit} label={t("frontend.slug")} placeholder={t("frontend.slug_placeholder")} required containerClassName="flex-[1_1_240px]" />
                    </div>
                    <TextareaField name="description" label={t("frontend.description")} placeholder={t("frontend.description_placeholder")} />
                </CardContent>
            </Card>
            {hasRepositories && <CodeRepositorySection repositoriesData={repositories || []} isEdit={!!id} frontendId={id} savedRepository={frontend?.codeRepository} forceCreation={!isEdit} />}
        </div>
    )
}
