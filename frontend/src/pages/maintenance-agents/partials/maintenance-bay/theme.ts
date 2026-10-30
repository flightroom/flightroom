import type { MaintenanceStatus } from "../maintenance"

export interface Hull {
    hull: string
    hullEdge: string
    panel: string
    rivet: string
    recess: [string, string]
    recessEdge: string
    space: [string, string]
    /** The labels, the stars and the stencils, as HSL components */
    ink: string
    starAlpha: number
    frame: string
    frameLight: string
    glassAlpha: number
    metal: [string, string, string]
    visor: string
    hazard: string
    hazardDark: string
    backend: string
    canister: string
    flame: string
    nebulae: [string, string]
    glowAlpha: number
    failed: string
    scheduled: string
    standby: string
}

/**
 * The colours of the station, from the same brand scales of the design system as the sky of the domains:
 * a charcoal hull around deep space in the dark theme, brushed steel around a star chart on paper in the light one.
 */
export const HULLS: Record<"dark" | "light", Hull> = {
    dark: {
        hull: "#0C2533",
        hullEdge: "#2F4959", // charcoal-800
        panel: "hsl(203 30% 40% / 0.22)",
        rivet: "#2F4959",
        recess: ["#04121A", "#0A2230"],
        recessEdge: "#1B3647",
        space: ["#020E15", "#07202D"], // charcoal-950
        ink: "38 44% 96%", // foreground (dark)
        starAlpha: 1,
        frame: "#233D4D", // charcoal-900
        frameLight: "#486172", // charcoal-700
        glassAlpha: 0.07,
        metal: ["#E4EFF6", "#B7C7D2", "#637B8B"], // charcoal-100, 300, 600
        visor: "#07202D",
        hazard: "#FCCA46", // sunglow-200
        hazardDark: "#0C2533",
        backend: "162 28% 61%", // zomp-400
        canister: "162 51% 81%", // zomp-200
        flame: "44 97% 63%", // sunglow-200
        nebulae: ["162 28% 61%", "24 99% 59%"], // zomp-400, pumpkin-400
        glowAlpha: 0.5,
        failed: "0 84% 64%",
        scheduled: "91 41% 69%", // olivine-300
        standby: "44 97% 63%" // sunglow-200
    },
    light: {
        hull: "#D0DDE6", // charcoal-200
        hullEdge: "#9BAEBB", // charcoal-400
        panel: "hsl(203 37% 22% / 0.13)",
        rivet: "#9BAEBB",
        recess: ["#E4EFF6", "#F6FBFE"],
        recessEdge: "#B7C7D2", // charcoal-300
        space: ["#EFF8FE", "#E4EFF6"], // charcoal-50, 100
        ink: "203 37% 22%", // charcoal-900
        starAlpha: 0.4,
        frame: "#486172", // charcoal-700
        frameLight: "#8096A4", // charcoal-500
        glassAlpha: 0.45,
        metal: ["#8096A4", "#486172", "#233D4D"], // charcoal-500, 700, 900
        visor: "#07202D",
        hazard: "#D3A312", // sunglow-400
        hazardDark: "#E4EFF6",
        backend: "163 27% 41%", // zomp-600
        canister: "164 33% 31%", // zomp-700
        flame: "45 84% 45%", // sunglow-400
        nebulae: ["162 23% 49%", "26 92% 47%"], // zomp-500, pumpkin-500
        glowAlpha: 0.32,
        failed: "0 72% 45%",
        scheduled: "89 27% 40%", // olivine-600
        standby: "46 92% 30%" // sunglow-600
    }
}
/** pumpkin-400, the primary of the design system */
const FALLBACK_PRIMARY = "24 99% 59%"
/** charcoal-50: the bright core of every world, as in the galaxies */
export const STAR_CORE = "204 88% 97%"

/** The light of a bay: the primary while it runs, the colour of its status otherwise */
export const statusColorOf = (status: MaintenanceStatus, hull: Hull, primary: string) => (status === "recent" ? primary : hull[status])

export const readPrimaryHue = () => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || FALLBACK_PRIMARY

export const ANIMATIONS = `
@media (prefers-reduced-motion: no-preference) {
    .mb-bob { animation: mb-bob 3.6s ease-in-out infinite; }
    .mb-thrust { animation: mb-thrust 0.9s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: 50% 0; }
    .mb-tether { animation: mb-tether 1.1s linear infinite; }
    .mb-beam { animation: mb-beam 1.6s linear infinite; }
    .mb-twinkle { animation: mb-twinkle 4s ease-in-out infinite; }
    .mb-pulse { animation: mb-pulse 1.8s ease-out infinite; transform-box: fill-box; transform-origin: center; }
    .mb-scan { animation: mb-scan 5s ease-in-out infinite; }
    .mb-flame { animation: mb-flame 0.16s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: 100% 50%; }
    .mb-breathe { animation: mb-breathe 6s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
}
@keyframes mb-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes mb-thrust { from { opacity: 0.55; transform: scaleY(0.8); } to { opacity: 1; transform: scaleY(1.12); } }
@keyframes mb-tether { to { stroke-dashoffset: -20; } }
@keyframes mb-beam { to { stroke-dashoffset: -18; } }
@keyframes mb-twinkle { 0%, 100% { opacity: 0.15; } 50% { opacity: 1; } }
@keyframes mb-pulse { from { opacity: 0.85; transform: scale(1); } to { opacity: 0; transform: scale(2.8); } }
@keyframes mb-scan { 0%, 100% { transform: translateX(-7px); } 50% { transform: translateX(7px); } }
@keyframes mb-flame { from { opacity: 0.8; transform: scaleX(0.82); } to { opacity: 1; transform: scaleX(1.08); } }
@keyframes mb-breathe { 0%, 100% { opacity: 0.8; transform: scale(1); } 50% { opacity: 1; transform: scale(1.08); } }
.mb-fade { transition: opacity 200ms ease, stroke-width 200ms ease; }
`
