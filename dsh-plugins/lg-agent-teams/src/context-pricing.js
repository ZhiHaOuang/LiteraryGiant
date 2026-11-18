// Generated from dsh-context 0.82.1. See ../NOTICE and ../LICENSE-dsh-context.

// dsh-context/src/shared/estimate.ts
var CHARS_PER_TOKEN = 4;
var ROLE_OVERHEAD = 4;
var BLOCK_OVERHEAD = 4;
function estimateTextTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}
function estimateSystemContent(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  let characters = 0;
  for (const block of blocks) {
    const text = block !== null && typeof block === "object" && block.type === "text" ? block.text : void 0;
    if (typeof text === "string") {
      characters += text.length;
      continue;
    }
    try {
      const json = JSON.stringify(block);
      if (typeof json === "string") characters += json.length;
    } catch {
    }
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
}

// dsh-context/src/shared/imageTokens.ts
var PATCH_SIZE = 14;
var DOWNSAMPLE_RATIO = 3;
var MAX_TOKENS = 384;
var COMPRESS_PAD_TO = 4;
var MAX_WH_RATIO = 8;
var MIN_PIXELS = 147456;
var floorDiv = (a, b) => Math.floor(a / b);
var ceilDiv = (a, b) => Math.floor((a + b - 1) / b);
function gridTokens(rows, cols) {
  let n = rows * (cols + 1) + 2;
  if (rows % 2 === 1) n += cols + 1;
  n += ceilDiv(rows, 2) * (cols + 1) % 2 * 2;
  return n;
}
function solveResizeRatio(height, width, budget) {
  const ratio = height / width;
  const gridW = Math.sqrt((budget - 2) / ratio + 0.25) - 0.5;
  const gridH = gridW * ratio;
  const unit = PATCH_SIZE * DOWNSAMPLE_RATIO;
  let bestHeight;
  let bestWidth;
  if (gridW < 1) {
    let rows = floorDiv(budget - 2, 2);
    if (rows % 2 === 1) rows -= 1;
    bestWidth = unit;
    bestHeight = rows * unit;
  } else if (gridH < 2) {
    const cols = floorDiv(budget - 2, 2) - 1;
    if (cols <= 1) throw new Error("image tokens: budget too small to solve");
    bestHeight = 2 * unit;
    bestWidth = cols * unit;
  } else {
    const cols = Math.trunc(gridW);
    let rows = Math.trunc(gridH);
    if (rows % 2 === 1) rows -= 1;
    const scale = Math.min(cols * unit / width, rows * unit / height);
    bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE;
    bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE;
  }
  const nLlmH = ceilDiv(floorDiv(bestHeight, PATCH_SIZE), DOWNSAMPLE_RATIO);
  const nLlmW = ceilDiv(floorDiv(bestWidth, PATCH_SIZE), DOWNSAMPLE_RATIO);
  return { nLlmH, nLlmW, bestHeight, bestWidth, numTokens: gridTokens(nLlmH, nLlmW) };
}
function safeResize(height, width, paddedHeight, paddedWidth) {
  const nLlmH = ceilDiv(floorDiv(paddedHeight, PATCH_SIZE), DOWNSAMPLE_RATIO);
  const nLlmW = ceilDiv(floorDiv(paddedWidth, PATCH_SIZE), DOWNSAMPLE_RATIO);
  const pad = COMPRESS_PAD_TO - 1;
  const budget = MAX_TOKENS - pad;
  let result = {
    nLlmH,
    nLlmW,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(nLlmH, nLlmW)
  };
  if (result.numTokens > budget) {
    result = solveResizeRatio(height, width, budget);
    let nextBudget = budget;
    while (result.numTokens > budget) {
      nextBudget -= 1;
      result = solveResizeRatio(height, width, nextBudget);
    }
  }
  result.numTokens += pad;
  return result;
}
function calcResizeInner(width, height) {
  let w = width;
  let h = height;
  if (w > h * MAX_WH_RATIO) w = h * MAX_WH_RATIO;
  const pixels = w * h;
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels);
    w = Math.trunc(w * scale);
    h = Math.trunc(h * scale);
  }
  const paddedWidth = ceilDiv(w, PATCH_SIZE) * PATCH_SIZE;
  const paddedHeight = ceilDiv(h, PATCH_SIZE) * PATCH_SIZE;
  return safeResize(h, w, paddedHeight, paddedWidth);
}
function estimateImageTokens(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  try {
    let result = calcResizeInner(width, height);
    for (let i = 1; i < 10; i++) {
      const next = calcResizeInner(result.bestWidth, result.bestHeight);
      if (next.nLlmH === result.nLlmH && next.nLlmW === result.nLlmW && next.bestHeight === result.bestHeight && next.bestWidth === result.bestWidth && next.numTokens === result.numTokens) return result.numTokens;
      result = next;
    }
    return null;
  } catch {
    return null;
  }
}

// dsh-context/src/host/pricing.ts
var CHARS_PER_TOKEN2 = 4;
var BLOCK_OVERHEAD2 = 4;
var ROLE_OVERHEAD2 = 4;
function estimateToolsTotal(tools) {
  return tools.length > 0 ? Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN2) + BLOCK_OVERHEAD2 : 0;
}
var textBlockPrice = (block) => estimateTextTokens(block.text || "");
var callBlockPrice = (block) => Math.ceil((block.name || "").length / CHARS_PER_TOKEN2) + Math.ceil((block.arguments || "").length / CHARS_PER_TOKEN2) + BLOCK_OVERHEAD2;
function estimateBlocks(blocks) {
  let tokens = 0;
  if (!Array.isArray(blocks)) return 0;
  for (const item of blocks) {
    if (item === null || typeof item !== "object") {
      tokens += BLOCK_OVERHEAD2;
      continue;
    }
    const block = item;
    switch (block.type) {
      case "text":
      case "reasoning":
        tokens += textBlockPrice(block);
        break;
      case "tool-call":
        tokens += callBlockPrice(block);
        break;
      case "image": {
        const ref = block.attachment;
        const priced = ref !== null && typeof ref === "object" && typeof ref.width === "number" && typeof ref.height === "number" ? estimateImageTokens(ref.width, ref.height) : null;
        tokens += (priced ?? Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN2)) + BLOCK_OVERHEAD2;
        break;
      }
      default:
        tokens += BLOCK_OVERHEAD2 + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN2);
    }
  }
  return tokens;
}
function estimateMessage(message, emptyIsZero = false) {
  if (emptyIsZero && (message === null || message === void 0 || !Array.isArray(message.content) || message.content.length === 0)) {
    return 0;
  }
  return estimateBlocks(message?.content) + ROLE_OVERHEAD2;
}
export {
  estimateMessage,
  estimateSystemContent,
  estimateToolsTotal
};
