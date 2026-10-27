import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import Mascot from "@/components/mascot/Mascot"

// Physics in px and seconds
const GRAVITY = 1400
const THRUST = -420
const BASE_SPEED = 170
const SPEED_PER_POINT = 5
const TOWER_WIDTH = 56
const TOWER_SPACING = 240
const GAP = 150
const VEGA_X_RATIO = 0.22
const VEGA_SIZE = 56
// A little smaller than the body of Vega, so that a graze does not count as a crash
const HITBOX = 10
// A tap meant for the last flap does not restart the game at once
const RESTART_DELAY = 500
const BEST_SCORE_KEY = "deploy-game-best"

type Phase = "ready" | "playing" | "over"

interface Tower {
    x: number
    gapY: number
    passed: boolean
}

interface Star {
    x: number
    y: number
    size: number
    speed: number
}

const readBestScore = () => {
    try {
        return Number(localStorage.getItem(BEST_SCORE_KEY)) || 0
    } catch {
        return 0
    }
}

const saveBestScore = (score: number) => {
    try {
        localStorage.setItem(BEST_SCORE_KEY, String(score))
    } catch {
        // Storage blocked: the record lasts as long as the page
    }
}

/** A design system token as a canvas colour: the tokens are HSL triplets */
const token = (name: string, alpha = 1) => `hsl(${getComputedStyle(document.documentElement).getPropertyValue(name).trim()} / ${alpha})`

/**
 * Vega to fly between the towers while the deploy runs: space, arrow up, a click or a tap give it thrust.
 * The game runs outside React, which only shows the score and the hints: the loop moves Vega, an SVG over the canvas.
 */
export const DeployGame: React.FC = () => {
    const { t } = useTranslation()
    const containerRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const vegaRef = useRef<HTMLDivElement>(null)
    const [phase, setPhase] = useState<Phase>("ready")
    const [score, setScore] = useState(0)
    const [best, setBest] = useState(readBestScore)
    const [isNewBest, setIsNewBest] = useState(false)

    useEffect(() => {
        const container = containerRef.current
        const canvas = canvasRef.current
        const vega = vegaRef.current
        const context = canvas?.getContext("2d")
        if (!container || !canvas || !vega || !context) return

        const colors = {
            tower: token("--muted-foreground", 0.3),
            towerEdge: token("--muted-foreground", 0.6),
            star: token("--foreground-secondary", 0.5)
        }
        const game = { phase: "ready" as Phase, y: 0, vy: 0, score: 0, best: readBestScore(), overAt: 0, thrustAt: -Infinity, towers: [] as Tower[] }
        let stars: Star[] = []
        let width = 0
        let height = 0
        let last = performance.now()
        let frame = 0

        const changePhase = (next: Phase) => {
            game.phase = next
            setPhase(next)
        }

        const resize = () => {
            const ratio = window.devicePixelRatio || 1
            width = container.clientWidth
            height = container.clientHeight
            canvas.width = width * ratio
            canvas.height = height * ratio
            context.setTransform(ratio, 0, 0, ratio, 0, 0)
            stars = Array.from({ length: Math.round(width / 12) }, () => ({
                x: Math.random() * width,
                y: Math.random() * height,
                size: Math.random() * 1.5 + 0.5,
                speed: Math.random() * 20 + 10
            }))
            if (game.phase !== "playing") game.y = height / 2
        }

        const start = () => {
            game.towers = []
            game.score = 0
            game.y = height / 2
            setScore(0)
            setIsNewBest(false)
            changePhase("playing")
        }

        const crash = () => {
            game.overAt = performance.now()
            changePhase("over")
            if (game.score > game.best) {
                game.best = game.score
                saveBestScore(game.score)
                setBest(game.score)
                setIsNewBest(true)
            }
        }

        const flap = () => {
            if (game.phase === "over" && performance.now() - game.overAt < RESTART_DELAY) return
            if (game.phase !== "playing") start()
            game.vy = THRUST
            game.thrustAt = performance.now()
        }

        const update = (dt: number, now: number) => {
            for (const star of stars) {
                star.x -= star.speed * dt * (game.phase === "playing" ? 3 : 1)
                if (star.x < 0) star.x += width
            }

            if (game.phase === "ready") {
                game.y = height / 2 + Math.sin(now / 300) * 8
                return
            }
            // After the crash Vega falls off the screen
            if (game.phase === "over") {
                if (game.y < height + 40) {
                    game.vy += GRAVITY * dt
                    game.y += game.vy * dt
                }
                return
            }

            game.vy += GRAVITY * dt
            game.y += game.vy * dt

            const speed = BASE_SPEED + game.score * SPEED_PER_POINT
            for (const tower of game.towers) tower.x -= speed * dt
            game.towers = game.towers.filter(tower => tower.x + TOWER_WIDTH > 0)
            const lastTower = game.towers[game.towers.length - 1]
            if (!lastTower || lastTower.x < width - TOWER_SPACING) {
                game.towers.push({ x: width, gapY: GAP / 2 + 20 + Math.random() * Math.max(0, height - GAP - 40), passed: false })
            }

            const vegaX = width * VEGA_X_RATIO
            for (const tower of game.towers) {
                if (!tower.passed && tower.x + TOWER_WIDTH < vegaX - HITBOX) {
                    tower.passed = true
                    game.score++
                    setScore(game.score)
                }
            }

            const outOfSky = game.y - HITBOX < 0 || game.y + HITBOX > height
            const hitTower = game.towers.some(
                tower => tower.x < vegaX + HITBOX && tower.x + TOWER_WIDTH > vegaX - HITBOX && (game.y - HITBOX < tower.gapY - GAP / 2 || game.y + HITBOX > tower.gapY + GAP / 2)
            )
            if (outOfSky || hitTower) crash()
        }

        const draw = (now: number) => {
            context.clearRect(0, 0, width, height)

            context.fillStyle = colors.star
            for (const star of stars) context.fillRect(star.x, star.y, star.size, star.size)

            context.fillStyle = colors.tower
            context.strokeStyle = colors.towerEdge
            context.lineWidth = 2
            for (const tower of game.towers) {
                context.beginPath()
                context.roundRect(tower.x, -10, TOWER_WIDTH, tower.gapY - GAP / 2 + 10, 10)
                context.roundRect(tower.x, tower.gapY + GAP / 2, TOWER_WIDTH, height - tower.gapY - GAP / 2 + 10, 10)
                context.fill()
                context.stroke()
            }

            // On a thrust its fins beat fast; it tilts with its speed
            const tilt = game.phase === "ready" ? 0 : Math.max(-0.4, Math.min(0.8, game.vy / 900))
            vega.style.transform = `translate(${width * VEGA_X_RATIO - VEGA_SIZE / 2}px, ${game.y - VEGA_SIZE / 2}px) rotate(${tilt}rad)`
            vega.classList.toggle("mascot-fast", now - game.thrustAt < 180)
        }

        const loop = (now: number) => {
            // A tab in the background pauses the frames: the first one back does not jump ahead
            const dt = Math.min((now - last) / 1000, 0.05)
            last = now
            update(dt, now)
            draw(now)
            frame = requestAnimationFrame(loop)
        }

        // Captured before the page sees it: space must not press a focused button underneath
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.code !== "Space" && event.code !== "ArrowUp") return
            event.preventDefault()
            event.stopPropagation()
            if (!event.repeat) flap()
        }

        const observer = new ResizeObserver(resize)
        observer.observe(container)
        resize()
        canvas.addEventListener("pointerdown", flap)
        window.addEventListener("keydown", onKeyDown, true)
        frame = requestAnimationFrame(loop)

        return () => {
            cancelAnimationFrame(frame)
            observer.disconnect()
            canvas.removeEventListener("pointerdown", flap)
            window.removeEventListener("keydown", onKeyDown, true)
        }
    }, [])

    return (
        <div ref={containerRef} className="relative h-[clamp(260px,50vh,420px)] w-full overflow-hidden rounded-xl border border-border bg-muted/40 touch-none select-none">
            <canvas ref={canvasRef} className="absolute inset-0 size-full cursor-pointer" role="img" aria-label={t("deployments.overlay.game.label")} />
            <div ref={vegaRef} className="pointer-events-none absolute left-0 top-0" style={{ width: VEGA_SIZE, height: VEGA_SIZE }}>
                <Mascot className="size-full" />
            </div>
            <div className="pointer-events-none absolute right-4 top-3 flex gap-4 text-sm font-medium tabular-nums">
                <span>{t("deployments.overlay.game.score", { score })}</span>
                <span className="text-foreground-secondary">{t("deployments.overlay.game.best", { score: best })}</span>
            </div>
            {phase !== "playing" && (
                <div className="pointer-events-none absolute inset-x-4 bottom-6 text-center" aria-live="polite">
                    {phase === "over" && <p className="font-semibold">{isNewBest ? t("deployments.overlay.game.new_best", { score }) : t("deployments.overlay.game.over", { count: score })}</p>}
                    <p className="text-sm text-foreground-secondary">{t(phase === "ready" ? "deployments.overlay.game.start" : "deployments.overlay.game.retry")}</p>
                </div>
            )}
        </div>
    )
}

export default DeployGame
