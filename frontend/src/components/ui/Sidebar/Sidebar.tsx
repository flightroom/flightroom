import { Sidebar as DesignSystemSidebar, type SidebarProps as DesignSystemSidebarProps, type SidebarNavItemProps } from "@flightroom/design-system"
import { BookOpen } from "lucide-react"
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Link, useLocation } from "react-router-dom"
import useBranding from "@/hooks/useBranding"
import { UserButton } from "./partials/UserButton"

export type { SidebarNavItemProps }

/** Una sezione della navigazione principale: un titolo e le sue voci. Senza titolo, le voci stanno in testa da sole. */
export interface SidebarNavSection {
    title?: string
    items: SidebarNavItemProps[]
}

/** Logo, titolo, blocco secondario, footer e router li decide questo componente. */
export type SidebarProps = Omit<DesignSystemSidebarProps, "logo" | "title" | "mainNavItems" | "secondaryNavItems" | "secondaryContent" | "footer" | "renderLink"> & {
    mainNavSections: SidebarNavSection[]
}

const EXTERNAL_NAV_ITEMS: SidebarNavItemProps[] = [{ name: "Documentation", path: "https://flightroom.dev/documentation/", icon: <BookOpen /> }]

/**
 * A section stays highlighted on its detail pages: `/backends` also covers `/backend/:id/...`, and
 * `/frontends` covers `/frontend/:id/...` (detail routes use the singular path).
 */
const isActivePath = (pathname: string, path: string) => pathname === path || (path.endsWith("s") && pathname.startsWith(`${path.slice(0, -1)}/`))

/** Compressa, la sidebar mostra solo un separatore: il titolo resta agli screen reader. */
const SectionTitle: React.FC<{ title: string; isCollapsed?: boolean }> = ({ title, isCollapsed }) =>
    isCollapsed ? (
        <h2 className="mx-2 mt-2 mb-1 border-t border-divider first:mt-0 first:border-t-0">
            <span className="sr-only">{title}</span>
        </h2>
    ) : (
        <h2 className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-foreground-secondary first:pt-0">{title}</h2>
    )

const Sidebar = React.forwardRef<HTMLDivElement, SidebarProps>(({ mainNavSections, ...props }, ref) => {
    const { t } = useTranslation()
    const branding = useBranding()
    const location = useLocation()

    const mainNavItems = mainNavSections.flatMap(section => section.items).map(item => ({ ...item, active: item.path ? isActivePath(location.pathname, item.path) : false }))
    // La sidebar del design system accetta una lista piatta: il titolo di una sezione lo rende la sua prima voce.
    const sectionTitleByPath = new Map(mainNavSections.flatMap(section => (section.title && section.items[0]?.path ? [[section.items[0].path, section.title] as const] : [])))

    return (
        <DesignSystemSidebar
            ref={ref}
            {...props}
            expandButtonLabel={t("navigation.expand_sidebar")}
            collapseButtonLabel={t("navigation.collapse_sidebar")}
            // Logo e nome portano alla home: il titolo lo rendiamo qui, dentro il link, invece di passarlo alla sidebar del design system
            logo={
                <Link to="/" aria-label={t("navigation.home")} className="flex items-center gap-3 rounded-sm">
                    <img src={branding.logoUrl} alt="" className="h-8 w-8 object-contain" />
                    {!props.isCollapsed && <span className="text-lg font-semibold text-foreground">{branding.name}</span>}
                </Link>
            }
            mainNavItems={mainNavItems}
            secondaryNavItems={EXTERNAL_NAV_ITEMS}
            footer={({ isCollapsed }) => <UserButton isSidebarCollapsed={isCollapsed} />}
            renderLink={({ href, className, children, onClick }) => {
                const sectionTitle = sectionTitleByPath.get(href)
                return (
                    <>
                        {sectionTitle && <SectionTitle title={sectionTitle} isCollapsed={props.isCollapsed} />}
                        <Link to={href} className={className} onClick={onClick}>
                            {children}
                        </Link>
                    </>
                )
            }}
        />
    )
})

Sidebar.displayName = "Sidebar"

export { Sidebar }
