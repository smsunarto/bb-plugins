declare module "virtual:bb-native-frame" {
  const NativeEditorFrame: import("react").ComponentType<{
    context: import("./editor-context").EditorContext;
    width: string;
    layout?: string;
    children: import("react").ReactNode;
  }>;
  export default NativeEditorFrame;
}
declare const __BB_NATIVE_AVAILABLE__: boolean;

declare const __BB_NATIVE_ERROR__: string;
interface Window {
  __bbNativeBackendAttempts?: { method: string; url: string }[];
  __STORYBOOK_ADDONS_CHANNEL__: { emit(event: string, payload: unknown): void };
}

declare module "*.css";
