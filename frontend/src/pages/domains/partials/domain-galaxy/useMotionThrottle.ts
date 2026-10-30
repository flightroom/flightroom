import { type RefObject, useCallback, useEffect, useRef, useState } from "react"
import type { ForceGraphMethods } from "react-force-graph-2d"
import { MOTION_FPS } from "./constants"
import type { Frame, LaneLink, StarNode } from "./types"

interface MotionThrottleInput {
    reducedMotion: boolean
    /** Whether there are moons, ships or stations on the map, anything that turns on its own */
    hasBodies: boolean
    /** While a relation is drawn the map follows the pointer at the screen's rate */
    linkSourceId: string | null
    isGraphMounted: boolean
    /** New data restarts the layout */
    graphData: unknown
}

/**
 * The moons and the ships keep the map redrawing on its own, but only while one of them is in view:
 * once the layout has settled, at MOTION_FPS rather than the screen's rate.
 */
const useMotionThrottle = (
    graphRef: RefObject<ForceGraphMethods<StarNode, LaneLink> | undefined>,
    frameRef: RefObject<Frame>,
    { reducedMotion, hasBodies, linkSourceId, isGraphMounted, graphData }: MotionThrottleInput
) => {
    const [motionOnScreen, setMotionOnScreen] = useState(false)
    const motionOnScreenRef = useRef(false)
    const turning = !reducedMotion && motionOnScreen && hasBodies
    const throttled = turning && !linkSourceId
    const throttledRef = useRef(false)
    // Whether the layout has settled: until it has, every frame also moves the stars, and none is skipped.
    const engineStoppedRef = useRef(false)
    // biome-ignore lint/correctness/useExhaustiveDependencies: new data is what restarts the layout.
    useEffect(() => {
        engineStoppedRef.current = false
    }, [graphData])

    useEffect(() => {
        throttledRef.current = throttled
        if (!throttled || !isGraphMounted) return
        // Each tick draws one frame: the frame pauses the loop right after (see onRenderFramePost).
        const interval = setInterval(() => graphRef.current?.resumeAnimation(), 1000 / MOTION_FPS)
        return () => {
            clearInterval(interval)
            throttledRef.current = false
            // Unmounted, the ref is already gone: nothing is restarted on a canvas no longer shown.
            graphRef.current?.resumeAnimation()
        }
    }, [graphRef, throttled, isGraphMounted])

    const onRenderFramePost = useCallback(() => {
        // Throttled: the loop schedules its next frame after this callback, so it is cancelled once this frame is over.
        if (throttledRef.current && engineStoppedRef.current) queueMicrotask(() => graphRef.current?.pauseAnimation())
        // A moon or a ship coming into view, or the last one leaving it, turns the redrawing on its own on or off.
        const { motion } = frameRef.current
        if (motion !== motionOnScreenRef.current) {
            motionOnScreenRef.current = motion
            setMotionOnScreen(motion)
        }
    }, [graphRef, frameRef])

    return { turning, engineStoppedRef, onRenderFramePost }
}

export default useMotionThrottle
