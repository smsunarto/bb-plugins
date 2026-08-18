import * as react from 'react';
import * as react_jsx_runtime from 'react/jsx-runtime';

type Annotation = {
    id: string;
    x: number;
    y: number;
    comment: string;
    element: string;
    elementPath: string;
    timestamp: number;
    selectedText?: string;
    boundingBox?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    nearbyText?: string;
    cssClasses?: string;
    nearbyElements?: string;
    computedStyles?: string;
    fullPath?: string;
    accessibility?: string;
    isMultiSelect?: boolean;
    isFixed?: boolean;
    reactComponents?: string;
    sourceFile?: string;
    drawingIndex?: number;
    elementBoundingBoxes?: Array<{
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
    kind?: "feedback" | "placement" | "rearrange";
    placement?: {
        componentType: string;
        width: number;
        height: number;
        scrollY: number;
        text?: string;
    };
    rearrange?: {
        selector: string;
        label: string;
        tagName: string;
        originalRect: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
        currentRect: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
    };
    sessionId?: string;
    url?: string;
    intent?: AnnotationIntent;
    severity?: AnnotationSeverity;
    status?: AnnotationStatus;
    thread?: ThreadMessage[];
    createdAt?: string;
    updatedAt?: string;
    resolvedAt?: string;
    resolvedBy?: "human" | "agent";
    authorId?: string;
    _syncedTo?: string;
};
type AnnotationIntent = "fix" | "change" | "question" | "approve";
type AnnotationSeverity = "blocking" | "important" | "suggestion";
type AnnotationStatus = "pending" | "acknowledged" | "resolved" | "dismissed";
type ThreadMessage = {
    id: string;
    role: "human" | "agent";
    content: string;
    timestamp: number;
};

type DemoAnnotation = {
    selector: string;
    comment: string;
    selectedText?: string;
};
type PageFeedbackToolbarCSSProps = {
    demoAnnotations?: DemoAnnotation[];
    demoDelay?: number;
    enableDemoMode?: boolean;
    /** Callback fired when an annotation is added. */
    onAnnotationAdd?: (annotation: Annotation) => void;
    /** Callback fired when an annotation is deleted. */
    onAnnotationDelete?: (annotation: Annotation) => void;
    /** Callback fired when an annotation comment is edited. */
    onAnnotationUpdate?: (annotation: Annotation) => void;
    /** Callback fired when all annotations are cleared. Receives the annotations that were cleared. */
    onAnnotationsClear?: (annotations: Annotation[]) => void;
    /** Callback fired when the copy button is clicked. Receives the markdown output. */
    onCopy?: (markdown: string) => void;
    /** Callback fired when "Send to Agent" is clicked. Receives the markdown output and annotations. */
    onSubmit?: (output: string, annotations: Annotation[]) => void;
    /** Whether to copy to clipboard when the copy button is clicked. Defaults to true. */
    copyToClipboard?: boolean;
    /** Server URL for sync (e.g., "http://localhost:4747"). If not provided, uses localStorage only. */
    endpoint?: string;
    /** Pre-existing session ID to join. If not provided with endpoint, creates a new session. */
    sessionId?: string;
    /** Called when a new session is created (only when endpoint is provided without sessionId). */
    onSessionCreated?: (sessionId: string) => void;
    /** Webhook URL to receive annotation events. */
    webhookUrl?: string;
    /** Custom class name applied to the toolbar container. Use to adjust positioning or z-index. */
    className?: string;
};
/** Alias for PageFeedbackToolbarCSSProps */
type AgentationProps = PageFeedbackToolbarCSSProps;
declare function PageFeedbackToolbarCSS({ demoAnnotations, demoDelay, enableDemoMode, onAnnotationAdd, onAnnotationDelete, onAnnotationUpdate, onAnnotationsClear, onCopy, onSubmit, copyToClipboard, endpoint, sessionId: initialSessionId, onSessionCreated, webhookUrl, className: userClassName, }?: PageFeedbackToolbarCSSProps): react.ReactPortal | null;

interface AnnotationPopupCSSProps {
    /** Element name to display in header */
    element: string;
    /** Optional timestamp display (e.g., "@ 1.23s" for animation feedback) */
    timestamp?: string;
    /** Optional selected/highlighted text */
    selectedText?: string;
    /** Placeholder text for the textarea */
    placeholder?: string;
    /** Initial value for textarea (for edit mode) */
    initialValue?: string;
    /** Label for submit button (default: "Add") */
    submitLabel?: string;
    /** Called when annotation is submitted with text */
    onSubmit: (text: string) => void;
    /** Called when popup is cancelled/dismissed */
    onCancel: () => void;
    /** Called when delete button is clicked (only shown if provided) */
    onDelete?: () => void;
    /** Position styles (left, top) */
    style?: React.CSSProperties;
    /** Custom color for submit button and textarea focus (hex) */
    accentColor?: string;
    /** External exit state (parent controls exit animation) */
    isExiting?: boolean;
    /** Light mode styling */
    lightMode?: boolean;
    /** Computed styles for the selected element */
    computedStyles?: Record<string, string>;
}
interface AnnotationPopupCSSHandle {
    /** Shake the popup (e.g., when user clicks outside) */
    shake: () => void;
}
declare const AnnotationPopupCSS: react.ForwardRefExoticComponent<AnnotationPopupCSSProps & react.RefAttributes<AnnotationPopupCSSHandle>>;

declare const IconClose: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconPlus: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconCheck: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconCheckSmall: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconListSparkle: ({ size, style, }: {
    size?: number;
    style?: React.CSSProperties;
}) => react_jsx_runtime.JSX.Element;
declare const IconHelp: ({ size, ...props }: {
    size?: number;
} & React.SVGProps<SVGSVGElement>) => react_jsx_runtime.JSX.Element;
declare const IconCheckSmallAnimated: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconCopyAlt: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconCopyAnimated: ({ size, copied, tint, }: {
    size?: number;
    copied?: boolean;
    tint?: string;
}) => react_jsx_runtime.JSX.Element;
declare const IconSendArrow: ({ size, state, }: {
    size?: number;
    state?: "idle" | "sending" | "sent" | "failed";
}) => react_jsx_runtime.JSX.Element;
declare const IconSendAnimated: ({ size, sent, }: {
    size?: number;
    sent?: boolean;
}) => react_jsx_runtime.JSX.Element;
declare const IconEye: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconEyeAlt: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconEyeClosed: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconEyeAnimated: ({ size, isOpen, }: {
    size?: number;
    isOpen?: boolean;
}) => react_jsx_runtime.JSX.Element;
declare const IconPausePlayAnimated: ({ size, isPaused, }: {
    size?: number;
    isPaused?: boolean;
}) => react_jsx_runtime.JSX.Element;
declare const IconEyeMinus: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconGear: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconPauseAlt: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconPause: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconPlayAlt: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconTrashAlt: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconChatEllipsis: ({ size, style, }: {
    size?: number;
    style?: React.CSSProperties;
}) => react_jsx_runtime.JSX.Element;
declare const IconCheckmark: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconCheckmarkLarge: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconCheckmarkCircle: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconXmark: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconXmarkLarge: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconSun: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconMoon: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconEdit: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconTrash: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconChevronLeft: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const IconChevronRight: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;
declare const AnimatedBunny: ({ size, color, }: {
    size?: number;
    color?: string;
}) => react_jsx_runtime.JSX.Element;
declare const IconLayout: ({ size }: {
    size?: number;
}) => react_jsx_runtime.JSX.Element;

/**
 * Finds the closest ancestor matching a selector, crossing shadow DOM boundaries.
 */
declare function closestCrossingShadow(element: Element, selector: string): Element | null;
/**
 * Checks if an element is inside a shadow DOM
 */
declare function isInShadowDOM(element: Element): boolean;
/**
 * Gets the shadow host for an element, or null if not in shadow DOM
 */
declare function getShadowHost(element: Element): Element | null;
/**
 * Gets a readable path for an element (e.g., "article > section > p")
 * Supports elements inside shadow DOM by crossing shadow boundaries.
 */
declare function getElementPath(target: HTMLElement, maxDepth?: number): string;
/**
 * Identifies an element and returns a human-readable name + path
 */
declare function identifyElement(target: HTMLElement): {
    name: string;
    path: string;
};
/**
 * Gets text content from element and siblings for context
 */
declare function getNearbyText(element: HTMLElement): string;
/**
 * Simplified element identifier for animation feedback (less verbose)
 */
declare function identifyAnimationElement(target: HTMLElement): string;
/**
 * Gets CSS class names from an element (cleaned of module hashes)
 */
declare function getElementClasses(target: HTMLElement): string;

declare function getStorageKey(pathname: string): string;
declare function loadAnnotations<T = Annotation>(pathname: string): T[];
declare function saveAnnotations<T = Annotation>(pathname: string, annotations: T[]): void;

export { PageFeedbackToolbarCSS as Agentation, type AgentationProps, AnimatedBunny, type Annotation, AnnotationPopupCSS, type AnnotationPopupCSSHandle, type AnnotationPopupCSSProps, type DemoAnnotation, IconChatEllipsis, IconCheck, IconCheckSmall, IconCheckSmallAnimated, IconCheckmark, IconCheckmarkCircle, IconCheckmarkLarge, IconChevronLeft, IconChevronRight, IconClose, IconCopyAlt, IconCopyAnimated, IconEdit, IconEye, IconEyeAlt, IconEyeAnimated, IconEyeClosed, IconEyeMinus, IconGear, IconHelp, IconLayout, IconListSparkle, IconMoon, IconPause, IconPauseAlt, IconPausePlayAnimated, IconPlayAlt, IconPlus, IconSendAnimated, IconSendArrow, IconSun, IconTrash, IconTrashAlt, IconXmark, IconXmarkLarge, PageFeedbackToolbarCSS, closestCrossingShadow, getElementClasses, getElementPath, getNearbyText, getShadowHost, getStorageKey, identifyAnimationElement, identifyElement, isInShadowDOM, loadAnnotations, saveAnnotations };
