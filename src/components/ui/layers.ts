// 统一管理 Radix portal 与全屏面板的层级，避免局部组件用更高 z-index 抢占真正的顶层弹窗。
export const UI_LAYER_CLASS = {
  dialogBase: "z-40",
  dialogNested: "z-50",
  dialogAlert: "z-[60]",
  floating: "z-[180]",
  dialogTop: "z-[200]",
  topDialogFloating: "z-[210]",
} as const;

// 对话框只允许使用这几个语义层级，调用方不需要关心具体数字。
export type DialogLayer = "base" | "nested" | "alert" | "top";

// Dialog 的 overlay 和 content 必须使用同一层级，否则遮罩与内容会被不同面板拆开。
export const DIALOG_LAYER_CLASS: Record<DialogLayer, string> = {
  base: UI_LAYER_CLASS.dialogBase,
  nested: UI_LAYER_CLASS.dialogNested,
  alert: UI_LAYER_CLASS.dialogAlert,
  top: UI_LAYER_CLASS.dialogTop,
};
