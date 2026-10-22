import { cn } from "@/utils/styleUtils"
import PageHead from "./PageHead"

export interface SinglePageHeaderProps extends React.PropsWithChildren {
    title: string
    /** Before the title, inside the heading */
    icon?: React.ReactNode
    description?: string
    left?: React.ReactNode
    right?: React.ReactNode
    lrContainerClassname?: string
    className?: string
    headerClassName?: string
}

const SinglePageLayout: React.FC<SinglePageHeaderProps> = ({ title, icon, description, left, right, children, lrContainerClassname, className, headerClassName }) => {
    return (
        <div className={cn("flex flex-col gap-6 min-h-full", className)}>
            <PageHead title={title} description={description} />
            <div className={cn("mb-4", headerClassName)}>
                <div>
                    <h1 className={cn("text-2xl font-bold text-foreground", icon && "flex items-center gap-2")}>
                        {icon}
                        {title}
                    </h1>
                    {description && <p className="text-primary-strong">{description}</p>}
                </div>
                {(left || right) && (
                    <div className={cn("@container mt-4 flex justify-between items-center gap-y-2 gap-x-4 flex-wrap", lrContainerClassname)}>
                        {left && <>{left}</>}
                        {right && <>{right}</>}
                    </div>
                )}
            </div>
            {children}
        </div>
    )
}

export default SinglePageLayout
