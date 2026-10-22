export interface EnvironmentPreset {
    slug: string
    name: string
    isProduction: boolean
    color: string
}

export interface EnvironmentPresetGroup {
    name: string
    environments: EnvironmentPreset[]
}

/**
 * The colours offered for an environment: the brand scales of the design system
 * (charcoal, pumpkin, sunglow, olivine, zomp), skipping the steps too close to tell apart.
 */
export const DEFAULT_COLORS = [
    // Zomp
    "#B6E7D8", // zomp-200
    "#9CD1C1", // zomp-300
    "#80B8A7", // zomp-400
    "#619B8A", // zomp-500
    "#4C8474", // zomp-600
    "#35695B", // zomp-700
    "#204F42", // zomp-800
    "#0F382E", // zomp-900

    // Olivine
    "#C7E7A8", // olivine-200
    "#A1C181", // olivine-400
    "#809E61", // olivine-500
    "#67824A", // olivine-600
    "#4F6635", // olivine-700
    "#384C22", // olivine-800

    // Sunglow
    "#FFEBBE", // sunglow-100
    "#FCCA46", // sunglow-200
    "#D3A312", // sunglow-400
    "#B58C05", // sunglow-500
    "#947206", // sunglow-600
    "#755900", // sunglow-700

    // Pumpkin
    "#FECFB7", // pumpkin-200
    "#FEAF84", // pumpkin-300
    "#FE7F2D", // pumpkin-400
    "#E4690A", // pumpkin-500
    "#BC5503", // pumpkin-600
    "#954203", // pumpkin-700
    "#702F00", // pumpkin-800
    "#502000", // pumpkin-900

    // Charcoal
    "#B7C7D2", // charcoal-300
    "#8096A4", // charcoal-500
    "#637B8B", // charcoal-600
    "#486172", // charcoal-700
    "#233D4D" // charcoal-900
]

const presetEnvironmentGroups: EnvironmentPresetGroup[] = [
    {
        name: "Ambienti Base",
        environments: [
            { slug: "DEV", name: "Development", isProduction: false, color: "#9CD1C1" }, // zomp-300
            { slug: "PROD", name: "Production", isProduction: true, color: "#A1C181" } // olivine-400
        ]
    },
    {
        name: "Ambienti Standard",
        environments: [
            { slug: "DEV", name: "Development", isProduction: false, color: "#9CD1C1" }, // zomp-300
            { slug: "UAT", name: "UAT", isProduction: false, color: "#FCCA46" }, // sunglow-200
            { slug: "PROD", name: "Production", isProduction: true, color: "#A1C181" } // olivine-400
        ]
    },
    {
        name: "Ambienti Completi",
        environments: [
            { slug: "DEV", name: "Development", isProduction: false, color: "#9CD1C1" }, // zomp-300
            { slug: "UAT", name: "UAT", isProduction: false, color: "#FCCA46" }, // sunglow-200
            { slug: "TEST", name: "Test", isProduction: false, color: "#FEAF84" }, // pumpkin-300
            { slug: "PROD", name: "Production", isProduction: true, color: "#A1C181" } // olivine-400
        ]
    }
]

export default presetEnvironmentGroups
