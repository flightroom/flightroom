import React from "react"
import { twMerge } from "tailwind-merge"
import useBranding from "@/hooks/useBranding"

interface MainLogoProps {
    /**
     * Additional CSS classes to apply to the logo
     */
    className?: string
    /**
     * Size of the logo
     * @default 'md'
     */
    size?: "sm" | "md" | "lg"
}

const sizeClasses = {
    sm: "h-8 w-8",
    md: "h-12 w-12",
    lg: "h-16 w-16"
}

/**
 * MainLogo component that displays the logo of the installation, Flightroom's unless one is set
 */
export const MainLogo: React.FC<MainLogoProps> = ({ className = "", size = "md" }) => {
    const { name, logoUrl } = useBranding()

    return <img src={logoUrl} alt={name} className={twMerge(sizeClasses[size], "object-contain", className)} data-testid="main-logo" />
}

export default MainLogo
