import { definePlugin } from "@bb-kit/core/plugin";
import { overview } from "./rpc/overview.ts";
import { create } from "./rpc/create.ts";
import { attach } from "./rpc/attach.ts";
import { get } from "./rpc/get.ts";
import { saveBoard } from "./rpc/save-board.ts";
import { saveDocument } from "./rpc/save-document.ts";
import { createDocument } from "./rpc/create-document.ts";
import { createBoard } from "./rpc/create-board.ts";
import { preview } from "./rpc/preview.ts";
import { updateGame } from "./rpc/update-game.ts";
import { uploadAsset } from "./rpc/upload-asset.ts";
import { prompt } from "./rpc/prompt.ts";
import { inspectUnity } from "./rpc/inspect-unity.ts";
import { recordRequest } from "./rpc/record-request.ts";

export default definePlugin({
  pluginId: "game-studio",
  rpc: {
    overview,
    create,
    attach,
    get,
    saveBoard,
    saveDocument,
    createDocument,
    createBoard,
    preview,
    updateGame,
    uploadAsset,
    prompt,
    inspectUnity,
    recordRequest,
  },
  rpcPublication: { discoverable: true },
});
