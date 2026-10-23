import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@flightroom/design-system"
import { ReactNode } from "react"
import MainLogo from "@/components/MainLogo"
import PageHead from "@/components/PageHead"
import LanguageSelector from "@/components/ui/Sidebar/partials/LanguageSelector"
import ThemeToggle from "@/components/ui/Sidebar/partials/ThemeToggle"
import { cn } from "@/utils/styleUtils"

interface AuthenticationLayoutProps {
    title: string | ReactNode
    description?: string | ReactNode
    children: ReactNode
    footer?: ReactNode
    /** `lg` widens the card for content that needs more room than a form, such as a grid of tiles. */
    size?: "default" | "lg"
}

const sizeClasses = {
    default: "max-w-md",
    lg: "max-w-2xl"
} as const

const AuthenticationLayout: React.FC<AuthenticationLayoutProps> = ({ title, description, children, footer, size = "default" }) => {
    return (
        // The body never scrolls (index.css), so a card taller than the viewport needs its own scroll container.
        <div className="h-dvh overflow-y-auto bg-gradient-to-b from-background to-muted">
            {/* title/description accept nodes for the on-screen card, but the document head only takes plain text. */}
            <PageHead title={typeof title === "string" ? title : undefined} description={typeof description === "string" ? description : undefined} />
            <div className="absolute top-4 right-4 flex items-center space-x-2">
                <LanguageSelector purpose="page" />
                <ThemeToggle purpose="page" />
            </div>
            {/* min-h-full + centering, not centering on the scroller: a centered overflow would clip the top unreachably. */}
            <div className="min-h-full flex items-center justify-center p-4">
                <div className={cn("w-full", sizeClasses[size])}>
                    <div className="flex justify-center mb-6">
                        <MainLogo />
                    </div>

                    <Card className="py-5">
                        <CardHeader>
                            <CardTitle className="text-2xl text-center mb-0">{title}</CardTitle>
                            {description && <CardDescription className="text-base text-center">{description}</CardDescription>}
                        </CardHeader>
                        <CardContent className="py-3">{children}</CardContent>
                        {footer && <CardFooter className="flex justify-center">{footer}</CardFooter>}
                    </Card>
                </div>
            </div>
        </div>
    )
}

export default AuthenticationLayout
