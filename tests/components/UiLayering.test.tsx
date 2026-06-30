import { describe, expect, it } from "vitest";
import { DIALOG_LAYER_CLASS, UI_LAYER_CLASS } from "@/components/ui/layers";

// 从 Tailwind z-index class 中提取数字，用于验证层级顺序而不是只比对字符串。
function zValue(className: string): number {
  if (className.startsWith("z-[")) {
    return Number(className.slice(3, -1));
  }

  return Number(className.slice(2));
}

describe("UI layer ordering", () => {
  it("keeps floating portals above provider panels and below top dialogs", () => {
    const providerPanelAboveWizard = 140;

    expect(zValue(UI_LAYER_CLASS.floating)).toBeGreaterThan(
      providerPanelAboveWizard,
    );
    expect(zValue(UI_LAYER_CLASS.floating)).toBeLessThan(
      zValue(UI_LAYER_CLASS.dialogTop),
    );
    expect(zValue(UI_LAYER_CLASS.topDialogFloating)).toBeGreaterThan(
      zValue(UI_LAYER_CLASS.dialogTop),
    );
  });

  it("uses the shared dialog layer map for semantic dialog levels", () => {
    expect(DIALOG_LAYER_CLASS).toEqual({
      base: UI_LAYER_CLASS.dialogBase,
      nested: UI_LAYER_CLASS.dialogNested,
      alert: UI_LAYER_CLASS.dialogAlert,
      top: UI_LAYER_CLASS.dialogTop,
    });
  });
});
