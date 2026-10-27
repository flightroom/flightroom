import { useId } from "react"
import { cn } from "@/utils/styleUtils"

export type MascotMood = "idle" | "working" | "deploying" | "analyzing"

interface MascotProps {
    mood?: MascotMood
    className?: string
}

/**
 * The colours of the mascot, as drawn in the Figma file "Flightroom – Mascotte": the orange of the brand,
 * off-white fins, a navy visor and cyan light. It has no hands: it shows how it feels with its eyes and its
 * light, and a cyan beam holds its tools.
 */
const COLORS = {
    bodyLight: "#FFA060",
    body: "#FE7F2D",
    bodyDark: "#D9581A",
    visorEdge: "#C4561C",
    visor: ["#2B3852", "#141B28"],
    fin: ["#FBF8F2", "#E2DACD"],
    finBack: ["#F5F0E8", "#D9D1C4"],
    eye: "#7FE6F5",
    light: "#4FD1E8",
    lightCore: "#C9F6FF",
    navy: "#1B2433",
    metal: ["#F4F7FA", "#9AA6B2"],
    metalEdge: "#6B7785",
    smoke: "#D9DEE4"
}

/** Each mood is framed like its pose in Figma: the body stays in the same place, the room around it changes. */
const VIEW_BOX: Record<MascotMood, string> = {
    idle: "-64 -64 640 640",
    working: "-40 -100 640 640",
    deploying: "-64 0 640 640",
    analyzing: "-64 -64 640 640"
}

const ANIMATIONS = `
@media (prefers-reduced-motion: no-preference) {
    .mascot-bob { animation: mascot-bob 3.6s ease-in-out infinite; }
    .mascot-rattle { animation: mascot-bob 0.35s ease-in-out infinite; }
    .mascot-fin-back { animation: mascot-fin-back 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: 100% 85%; }
    .mascot-fin-front { animation: mascot-fin-front 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: 0% 60%; }
    .mascot-fast .mascot-fin-back, .mascot-fast .mascot-fin-front { animation-duration: 0.4s; }
    .mascot-blink { animation: mascot-blink 4.5s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
    .mascot-thrust { animation: mascot-thrust 1.2s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: center; }
    .mascot-flame { animation: mascot-flame 0.14s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: 50% 0; }
    .mascot-smoke { animation: mascot-smoke 1.6s ease-out infinite; transform-box: fill-box; transform-origin: center; }
    .mascot-speed { animation: mascot-speed 0.7s linear infinite; }
    .mascot-wrench { animation: mascot-wrench 0.7s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: 0% 50%; }
    .mascot-twinkle { animation: mascot-twinkle 0.7s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: center; }
    .mascot-float { animation: mascot-float 2.8s ease-in-out infinite; }
    .mascot-beam { animation: mascot-beam 1.4s ease-in-out infinite alternate; }
    .mascot-lens { animation: mascot-lens 3.2s ease-in-out infinite; }
    .mascot-scan { animation: mascot-scan 1.8s ease-in-out infinite; }
}
@keyframes mascot-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
@keyframes mascot-fin-back { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(10deg); } }
@keyframes mascot-fin-front { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(-10deg); } }
@keyframes mascot-blink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
@keyframes mascot-thrust { from { opacity: 0.6; transform: scale(0.85); } to { opacity: 1; transform: scale(1.1); } }
@keyframes mascot-flame { from { opacity: 0.85; transform: scaleY(0.88); } to { opacity: 1; transform: scaleY(1.06); } }
@keyframes mascot-smoke { from { opacity: 0.9; transform: scale(0.6); } to { opacity: 0; transform: scale(1.25); } }
@keyframes mascot-speed { from { opacity: 0; transform: translateY(-30px); } 30% { opacity: 1; } to { opacity: 0; transform: translateY(50px); } }
@keyframes mascot-wrench { from { transform: rotate(-8deg); } to { transform: rotate(8deg); } }
@keyframes mascot-twinkle { from { opacity: 0.3; transform: scale(0.6) rotate(0deg); } to { opacity: 1; transform: scale(1.1) rotate(20deg); } }
@keyframes mascot-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
@keyframes mascot-beam { from { opacity: 0.55; } to { opacity: 1; } }
@keyframes mascot-lens { 0%, 100% { transform: translate(0, 0); } 33% { transform: translate(8px, -5px); } 66% { transform: translate(-6px, 4px); } }
@keyframes mascot-scan { 0%, 100% { opacity: 0.15; } 50% { opacity: 0.8; } }
`

/** The radii of the left and right eye: narrowed at work, the right one bigger behind the magnifying glass. */
const EYES: Record<Exclude<MascotMood, "deploying">, [{ rx: number; ry: number }, { rx: number; ry: number }]> = {
    idle: [
        { rx: 14, ry: 22 },
        { rx: 14, ry: 22 }
    ],
    working: [
        { rx: 15, ry: 8 },
        { rx: 15, ry: 8 }
    ],
    analyzing: [
        { rx: 14, ry: 22 },
        { rx: 20, ry: 29 }
    ]
}

/** The eyes of each mood, drawn on the visor: the light is the whole face. */
const Eyes: React.FC<{ mood: MascotMood }> = ({ mood }) => {
    if (mood === "deploying") {
        return (
            <g fill="none" stroke={COLORS.eye} strokeWidth={8} strokeLinecap="round">
                <path d="M182 262 A12 12 0 0 1 206 262" />
                <path d="M248 262 A12 12 0 0 1 272 262" />
            </g>
        )
    }
    const [left, right] = EYES[mood]
    return (
        <g className="mascot-blink" fill={COLORS.eye}>
            <ellipse cx={194} cy={256} rx={left.rx} ry={left.ry} />
            <ellipse cx={260} cy={256} rx={right.rx} ry={right.ry} />
        </g>
    )
}

/** The wrench, held by the beam and turning a bolt with its jaw. */
const Wrench: React.FC<{ id: string }> = ({ id }) => (
    <g transform="translate(340 90) rotate(-30)">
        <g className="mascot-wrench">
            <mask id={`${id}-wrench`}>
                <rect x={-10} y={-10} width={240} height={90} fill="#fff" />
                <rect x={-6} y={22} width={36} height={26} fill="#000" />
                <circle cx={190} cy={35} r={7} fill="#000" />
            </mask>
            <g mask={`url(#${id}-wrench)`} fill={`url(#${id}-metal)`} stroke={COLORS.metalEdge} strokeWidth={2}>
                <circle cx={35} cy={35} r={35} />
                <rect x={50} y={22} width={140} height={26} rx={13} />
                <circle cx={190} cy={35} r={20} />
            </g>
        </g>
    </g>
)

const hexagon = (cx: number, cy: number, r: number) =>
    Array.from({ length: 6 }, (_, index) => {
        const angle = (Math.PI / 3) * index
        return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`
    }).join(" ")

const Working: React.FC<{ id: string }> = ({ id }) => (
    <g>
        <path className="mascot-beam" d="M288 198 L400 68 L442 114 L306 218 Z" fill={`url(#${id}-beam)`} />
        <Wrench id={id} />
        {[
            { cx: 345, cy: 117, r: 13, delay: 0 },
            { cx: 531, cy: 31, r: 11, delay: 0.6 },
            { cx: 565, cy: 119, r: 9, delay: 1.2 },
            { cx: 480, cy: -22, r: 8, delay: 1.8 }
        ].map(bolt => (
            <polygon
                key={`${bolt.cx}-${bolt.cy}`}
                className="mascot-float"
                style={{ animationDelay: `-${bolt.delay}s` }}
                points={hexagon(bolt.cx, bolt.cy, bolt.r)}
                fill={`url(#${id}-metal)`}
                stroke={COLORS.metalEdge}
                strokeWidth={2}
            />
        ))}
        <path className="mascot-twinkle" d="M337 86 L343 97 L354 103 L343 109 L337 120 L331 109 L320 103 L331 97 Z" fill={COLORS.lightCore} />
    </g>
)

/** Under the body, behind it: the flame of the deploy, then the smoke it leaves. */
const DeployingBelow: React.FC<{ id: string }> = ({ id }) => (
    <g>
        {[
            { cx: 266, cy: 542, rx: 30, ry: 22, delay: 0 },
            { cx: 173, cy: 583, rx: 37, ry: 27, delay: 0.4 },
            { cx: 323, cy: 586, rx: 35, ry: 26, delay: 0.8 },
            { cx: 252, cy: 613, rx: 46, ry: 33, delay: 1.2 }
        ].map(puff => (
            <ellipse
                key={puff.cx}
                className="mascot-smoke"
                style={{ animationDelay: `-${puff.delay}s` }}
                cx={puff.cx}
                cy={puff.cy}
                rx={puff.rx}
                ry={puff.ry}
                fill="#fff"
                stroke={COLORS.smoke}
                strokeWidth={3}
            />
        ))}
        <g transform="translate(203 382) scale(1.2 1.19)">
            <g className="mascot-flame">
                <path d="M10 0 L70 0 C76 40 62 100 40 160 C18 100 4 40 10 0 Z" fill={`url(#${id}-flame)`} />
                <path d="M24 0 L56 0 C58 30 50 70 40 108 C30 70 22 30 24 0 Z" fill={`url(#${id}-flame-core)`} />
            </g>
        </g>
    </g>
)

const SPEED_LINES = [
    { x: 36, y: 300, length: 120, delay: 0 },
    { x: 76, y: 360, length: 90, delay: 0.35 },
    { x: 466, y: 300, length: 120, delay: 0.2 },
    { x: 431, y: 360, length: 90, delay: 0.5 }
]

const Deploying: React.FC = () => (
    <g stroke={COLORS.light} strokeWidth={6} strokeLinecap="round" opacity={0.55}>
        {SPEED_LINES.map(line => (
            <path key={line.x} className="mascot-speed" style={{ animationDelay: `-${line.delay}s` }} d={`M${line.x} ${line.y} V${line.y + line.length}`} />
        ))}
    </g>
)

/** The magnifying glass in front of the right eye, which looks bigger through it, and the scan lines beside. */
const Analyzing: React.FC = () => (
    <g>
        <g stroke={COLORS.light} strokeWidth={5} strokeLinecap="round">
            {[
                { d: "M-46 186 H18", delay: 0 },
                { d: "M-56 226 H24", delay: 0.3 },
                { d: "M-46 266 H18", delay: 0.6 }
            ].map(line => (
                <path key={line.d} className="mascot-scan" style={{ animationDelay: `-${line.delay}s` }} d={line.d} />
            ))}
        </g>
        <g className="mascot-lens">
            <g transform="translate(212 208)">
                <path d="M80 80 L138 138" stroke={COLORS.navy} strokeWidth={22} strokeLinecap="round" />
                <circle cx={48} cy={48} r={40} fill={COLORS.light} fillOpacity={0.18} />
                <circle cx={48} cy={48} r={44} fill="none" stroke={COLORS.navy} strokeWidth={12} />
                <circle cx={48} cy={48} r={44} fill="none" stroke={COLORS.fin[0]} strokeWidth={7} />
                <ellipse cx={36} cy={26} rx={12} ry={6} transform="rotate(-30 36 26)" fill="#fff" fillOpacity={0.6} />
            </g>
        </g>
    </g>
)

/**
 * Vega, the mascot of Flightroom and the name of its assistant: a small orange drone, in four moods: hovering (idle), fixing something with a
 * wrench (working), blasting off for a deploy (deploying), looking through a magnifying glass (analyzing).
 * Decorative: the text next to it says what is going on.
 */
export const Mascot: React.FC<MascotProps> = ({ mood = "idle", className }) => {
    const id = `mascot${useId().replace(/[^a-zA-Z0-9]/g, "")}`

    return (
        <svg viewBox={VIEW_BOX[mood]} className={cn("size-24 overflow-visible", mood === "deploying" && "mascot-fast", className)} aria-hidden="true" focusable="false">
            <style>{ANIMATIONS}</style>
            <defs>
                <radialGradient id={`${id}-body`} cx="0.38" cy="0.4" r="0.65">
                    <stop offset="0" stopColor={COLORS.bodyLight} />
                    <stop offset="0.55" stopColor={COLORS.body} />
                    <stop offset="1" stopColor={COLORS.bodyDark} />
                </radialGradient>
                <radialGradient id={`${id}-shine`}>
                    <stop offset="0" stopColor="#fff" stopOpacity={0.45} />
                    <stop offset="1" stopColor="#fff" stopOpacity={0} />
                </radialGradient>
                <radialGradient id={`${id}-thrust`}>
                    <stop offset="0" stopColor={COLORS.lightCore} />
                    <stop offset="0.45" stopColor={COLORS.light} stopOpacity={0.75} />
                    <stop offset="1" stopColor={COLORS.light} stopOpacity={0} />
                </radialGradient>
                <linearGradient id={`${id}-visor`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={COLORS.visor[0]} />
                    <stop offset="1" stopColor={COLORS.visor[1]} />
                </linearGradient>
                <linearGradient id={`${id}-fin`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={COLORS.fin[0]} />
                    <stop offset="1" stopColor={COLORS.fin[1]} />
                </linearGradient>
                <linearGradient id={`${id}-fin-back`} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor={COLORS.finBack[0]} />
                    <stop offset="1" stopColor={COLORS.finBack[1]} />
                </linearGradient>
                <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor={COLORS.metal[0]} />
                    <stop offset="1" stopColor={COLORS.metal[1]} />
                </linearGradient>
                <linearGradient id={`${id}-beam`} x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0" stopColor={COLORS.light} stopOpacity={0.6} />
                    <stop offset="1" stopColor={COLORS.light} stopOpacity={0.08} />
                </linearGradient>
                <linearGradient id={`${id}-flame`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#FFC24D" />
                    <stop offset="0.5" stopColor={COLORS.body} stopOpacity={0.9} />
                    <stop offset="1" stopColor={COLORS.body} stopOpacity={0} />
                </linearGradient>
                <linearGradient id={`${id}-flame-core`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#fff" />
                    <stop offset="0.4" stopColor={COLORS.lightCore} />
                    <stop offset="1" stopColor={COLORS.light} stopOpacity={0} />
                </linearGradient>
            </defs>

            {mood === "deploying" && <DeployingBelow id={id} />}

            <g className={mood === "deploying" ? "mascot-rattle" : "mascot-bob"}>
                <ellipse className="mascot-thrust" cx={251} cy={398} rx={58} ry={32} fill={`url(#${id}-thrust)`} />
                <path className="mascot-fin-back" d="M150 255 C115 235 75 205 52 175 C40 158 52 144 72 150 C110 162 148 190 172 222 Z" fill={`url(#${id}-fin-back)`} />
                <ellipse cx={256} cy={259} rx={150} ry={131} fill={`url(#${id}-body)`} />
                <ellipse cx={255} cy={161} rx={60} ry={22} fill={`url(#${id}-shine)`} />
                <rect x={138} y={182} width={176} height={150} rx={64} fill={`url(#${id}-visor)`} stroke={COLORS.visorEdge} strokeWidth={4} />
                <rect x={170} y={194} width={96} height={16} rx={8} fill="#fff" fillOpacity={0.18} />
                <g style={{ filter: `drop-shadow(0 0 7px ${COLORS.light})` }}>
                    <Eyes mood={mood} />
                </g>
                <path className="mascot-fin-front" d="M362 264 C405 246 452 238 486 240 C504 241 508 258 492 266 C455 284 405 296 368 298 C352 296 348 272 362 264 Z" fill={`url(#${id}-fin)`} />
            </g>

            {mood === "working" && <Working id={id} />}
            {mood === "deploying" && <Deploying />}
            {mood === "analyzing" && <Analyzing />}
        </svg>
    )
}

export default Mascot
