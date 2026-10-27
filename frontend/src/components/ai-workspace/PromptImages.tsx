import { Paperclip, X } from "lucide-react"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/atoms"
import type { PromptImage } from "@/hooks/apiClients/useAiChangesApi"
import useToastNotificationStore from "@/store/useToastNotificationStore"
import { cn } from "@/utils/styleUtils"

/** The formats every model the agent runs on reads. */
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
export const MAX_PROMPT_IMAGES = 5
/** What the models look at anyway: a larger image is scaled down on their side and only costs upload time. */
const MAX_EDGE = 1568
/** Five of them stay under the body limit of the API and the 16 MB of the job document they are saved on. */
const MAX_BYTES = 2 * 1024 * 1024

/**
 * Scaled down so its long edge fits MAX_EDGE. A PNG stays a PNG, so a screenshot keeps its sharp text; a GIF keeps
 * its first frame as a PNG; a photo becomes a JPEG.
 */
const downsize = async (file: File): Promise<PromptImage> => {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext("2d")
    if (!context) throw new Error("No canvas")
    const mediaType = file.type === "image/png" || file.type === "image/gif" ? "image/png" : "image/jpeg"
    // JPEG has no transparency: what was transparent turns white rather than black.
    if (mediaType === "image/jpeg") {
        context.fillStyle = "#fff"
        context.fillRect(0, 0, canvas.width, canvas.height)
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const url = canvas.toDataURL(mediaType, 0.85)
    return { mediaType, data: url.slice(url.indexOf(",") + 1) }
}

const bytesOf = (image: PromptImage) => Math.floor((image.data.length * 3) / 4)

/** The images of a prompt: added by pasting, dropping or picking them, each scaled down before it is sent. */
export const usePromptImages = () => {
    const { t } = useTranslation()
    const notifications = useToastNotificationStore()
    const [images, setImages] = useState<PromptImage[]>([])
    const [dragging, setDragging] = useState(false)
    const count = useRef(0)
    count.current = images.length

    const add = async (files: File[]) => {
        const supported = files.filter(file => ACCEPTED_TYPES.includes(file.type))
        if (supported.length < files.length) notifications.showErrorNotification({ message: t("frontend.aiChange.images.unsupported") })
        const room = MAX_PROMPT_IMAGES - count.current
        if (supported.length > room) notifications.showErrorNotification({ message: t("frontend.aiChange.images.too_many", { max: MAX_PROMPT_IMAGES }) })
        const added: PromptImage[] = []
        for (const file of supported.slice(0, Math.max(0, room))) {
            try {
                const image = await downsize(file)
                if (bytesOf(image) > MAX_BYTES) notifications.showErrorNotification({ message: t("frontend.aiChange.images.too_large", { name: file.name }) })
                else added.push(image)
            } catch {
                notifications.showErrorNotification({ message: t("frontend.aiChange.images.unreadable", { name: file.name }) })
            }
        }
        if (added.length) setImages(current => [...current, ...added].slice(0, MAX_PROMPT_IMAGES))
    }

    const remove = (index: number) => setImages(current => current.filter((_, position) => position !== index))
    const clear = () => setImages([])

    /** On the prompt: a pasted or dropped image is attached, pasted text goes in as usual. */
    const fieldProps = {
        onPaste: (event: React.ClipboardEvent) => {
            const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"))
            // Copied cells or slides come with a picture of themselves: their text is what was meant.
            if (files.length === 0 || event.clipboardData.getData("text/plain")) return
            event.preventDefault()
            void add(files)
        },
        onDragOver: (event: React.DragEvent) => {
            if (!event.dataTransfer.types.includes("Files")) return
            event.preventDefault()
            setDragging(true)
        },
        onDragLeave: () => setDragging(false),
        onDrop: (event: React.DragEvent) => {
            setDragging(false)
            if (event.dataTransfer.files.length === 0) return
            event.preventDefault()
            void add(Array.from(event.dataTransfer.files))
        }
    }

    return { images, add, remove, clear, fieldProps, dragging }
}

export type PromptImagesState = ReturnType<typeof usePromptImages>

interface AttachImageButtonProps {
    state: PromptImagesState
    disabled?: boolean
    dataTestId: string
}

/** Picks images from disk, for who does not paste nor drag them. */
export const AttachImageButton: React.FC<AttachImageButtonProps> = ({ state, disabled, dataTestId }) => {
    const { t } = useTranslation()
    const input = useRef<HTMLInputElement>(null)
    const full = state.images.length >= MAX_PROMPT_IMAGES

    return (
        <>
            <input
                ref={input}
                type="file"
                accept={ACCEPTED_TYPES.join(",")}
                multiple
                hidden
                onChange={event => {
                    void state.add(Array.from(event.target.files ?? []))
                    // The same file picked again must fire a change.
                    event.target.value = ""
                }}
            />
            <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("frontend.aiChange.images.attach")}
                title={t("frontend.aiChange.images.attach")}
                disabled={disabled || full}
                onClick={() => input.current?.click()}
                dataTestId={dataTestId}
            >
                <Paperclip aria-hidden="true" />
            </Button>
        </>
    )
}

interface PromptImageListProps {
    state: PromptImagesState
    disabled?: boolean
    className?: string
}

/** The attached images, each removable. Nothing while there are none. */
export const PromptImageList: React.FC<PromptImageListProps> = ({ state, disabled, className }) => {
    const { t } = useTranslation()
    if (state.images.length === 0) return null

    return (
        <ul className={cn("flex flex-wrap gap-2", className)} aria-label={t("frontend.aiChange.images.list_label")}>
            {state.images.map((image, index) => (
                <li key={index} className="relative">
                    <img
                        src={`data:${image.mediaType};base64,${image.data}`}
                        alt={t("frontend.aiChange.images.image_alt", { index: index + 1 })}
                        className="size-16 rounded-md border border-divider object-cover"
                    />
                    <button
                        type="button"
                        className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-divider bg-background text-foreground shadow-sm hover:bg-muted disabled:opacity-50"
                        aria-label={t("frontend.aiChange.images.remove", { index: index + 1 })}
                        disabled={disabled}
                        onClick={() => state.remove(index)}
                        data-testid="ai-change-image-remove"
                    >
                        <X className="size-3" aria-hidden="true" />
                    </button>
                </li>
            ))}
        </ul>
    )
}
