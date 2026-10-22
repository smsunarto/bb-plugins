import type { CanvasNode, NodeKind, StudioDocument } from "./schema.ts";

export const initialData = (
  kind: NodeKind,
  documents: Pick<StudioDocument, "id">[],
): CanvasNode["data"] => {
  switch (kind) {
    case "text":
      return { text: "", instruction: "", references: [] };
    case "document":
      return { documentId: documents[0]?.id ?? "", references: [] };
    case "image":
      return { prompt: "", images: [], resolution: "1K", aspectRatio: "1:1" };
    case "video":
      return { prompt: "", references: [], duration: 5, resolution: "720p", aspectRatio: "16:9" };
    case "model-3d":
      return { prompt: "", images: [], targetPolycount: 20000, texture: false, pbr: false };
    case "animate-3d":
      return { heightMeters: 1.8, actionIds: [] };
    case "agent":
      return { instruction: "", references: [] };
    case "asset":
      return { assetId: "", mediaType: "audio" };
    case "table":
      return { tableId: "" };
  }
};
