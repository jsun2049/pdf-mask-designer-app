const pdfjsLib = window.pdfjsLib;
const PDFLib = window.PDFLib;
const desktopBridge = window.desktopBridge || null;

const PT_PER_MM = 72 / 25.4;

const PRESET_RULES = [
  {
    id: "odd",
    name: "单页(奇数页)",
    applyTo: "odd",
  },
  {
    id: "even",
    name: "双页(偶数页)",
    applyTo: "even",
  },
];

const state = {
  pdfDoc: null,
  sourceBytes: null,
  fileName: "",
  currentPageNumber: 1,
  pageCount: 0,
  renderScale: 1.2,
  renderToken: 0,
  pageWidthPt: 0,
  pageHeightPt: 0,
  viewportWidthPx: 0,
  viewportHeightPx: 0,
  activeRuleId: "odd",
  autoRuleByPage: true,
  rules: PRESET_RULES.map((rule) => ({ ...rule, rects: [] })),
  draftRect: null,
  isDragging: false,
  dragStart: null,
};

const refs = {
  pdfFileInput: document.querySelector("#pdfFileInput"),
  fileLoadStatus: document.querySelector("#fileLoadStatus"),
  pageCountValue: document.querySelector("#pageCountValue"),
  currentPageValue: document.querySelector("#currentPageValue"),
  startPageInput: document.querySelector("#startPageInput"),
  endPageInput: document.querySelector("#endPageInput"),
  rangeStatus: document.querySelector("#rangeStatus"),
  ruleTabs: document.querySelector("#ruleTabs"),
  autoRuleCheckbox: document.querySelector("#autoRuleCheckbox"),
  activeRuleHint: document.querySelector("#activeRuleHint"),
  removeLastButton: document.querySelector("#removeLastButton"),
  clearRuleButton: document.querySelector("#clearRuleButton"),
  selectionHint: document.querySelector("#selectionHint"),
  processPdfButton: document.querySelector("#processPdfButton"),
  processStatus: document.querySelector("#processStatus"),
  pdfPathInput: document.querySelector("#pdfPathInput"),
  configPathInput: document.querySelector("#configPathInput"),
  copyCommandButton: document.querySelector("#copyCommandButton"),
  downloadConfigButton: document.querySelector("#downloadConfigButton"),
  copyJsonButton: document.querySelector("#copyJsonButton"),
  commandPreview: document.querySelector("#commandPreview"),
  jsonPreview: document.querySelector("#jsonPreview"),
  prevPageButton: document.querySelector("#prevPageButton"),
  nextPageButton: document.querySelector("#nextPageButton"),
  pageNumberInput: document.querySelector("#pageNumberInput"),
  zoomInput: document.querySelector("#zoomInput"),
  fileNameValue: document.querySelector("#fileNameValue"),
  activeRuleValue: document.querySelector("#activeRuleValue"),
  pageSizeValue: document.querySelector("#pageSizeValue"),
  emptyState: document.querySelector("#emptyState"),
  canvasStack: document.querySelector("#canvasStack"),
  pdfCanvas: document.querySelector("#pdfCanvas"),
  selectionLayer: document.querySelector("#selectionLayer"),
  ruleCollections: document.querySelector("#ruleCollections"),
};

if (!pdfjsLib || !PDFLib) {
  refs.fileLoadStatus.textContent = "本地依赖没有加载成功，请刷新页面后重试。";
  refs.fileLoadStatus.className = "status error";
} else if (desktopBridge?.isDesktopApp) {
  refs.fileLoadStatus.textContent = "桌面版已就绪，直接选择 PDF 即可，无需 Python 和本地服务。";
  refs.fileLoadStatus.className = "status success";
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function createId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function basename(pathValue, fallback) {
  const tokens = pathValue.split(/[\\/]/).filter(Boolean);
  return tokens.at(-1) || fallback;
}

function stripPdfExtension(name) {
  return name.replace(/\.pdf$/i, "");
}

function deriveMaskedPath(pathValue) {
  if (!pathValue.trim()) {
    return "./output-masked.pdf";
  }
  return pathValue.replace(/(\.pdf)?$/i, (match) => (match ? "-masked.pdf" : "-masked.pdf"));
}

function setStatus(element, message, kind = "neutral") {
  element.textContent = message;
  element.className = `status ${kind}`;
}

function showEmptyState(message) {
  refs.emptyState.textContent = message;
  refs.emptyState.classList.remove("hidden");
  refs.canvasStack.classList.add("hidden");
}

function showCanvas() {
  refs.emptyState.classList.add("hidden");
  refs.canvasStack.classList.remove("hidden");
}

function normalizeRect(rect) {
  const x0 = round(Math.min(rect.x0, rect.x1));
  const y0 = round(Math.min(rect.y0, rect.y1));
  const x1 = round(Math.max(rect.x0, rect.x1));
  const y1 = round(Math.max(rect.y0, rect.y1));
  return {
    id: rect.id || createId(),
    x0,
    y0,
    x1,
    y1,
  };
}

function rectWidth(rect) {
  return round(rect.x1 - rect.x0);
}

function rectHeight(rect) {
  return round(rect.y1 - rect.y0);
}

function rectToCss(rect) {
  if (!state.pageWidthPt || !state.pageHeightPt) {
    return null;
  }
  return {
    left: (rect.x0 / state.pageWidthPt) * state.viewportWidthPx,
    top: (rect.y0 / state.pageHeightPt) * state.viewportHeightPx,
    width: (rectWidth(rect) / state.pageWidthPt) * state.viewportWidthPx,
    height: (rectHeight(rect) / state.pageHeightPt) * state.viewportHeightPx,
  };
}

function getActiveRule() {
  return state.rules.find((rule) => rule.id === state.activeRuleId) || state.rules[0];
}

function ruleAppliesToPage(rule, pageNumber) {
  if (rule.applyTo === "odd") {
    return pageNumber % 2 === 1;
  }
  if (rule.applyTo === "even") {
    return pageNumber % 2 === 0;
  }
  return true;
}

function syncActiveRuleWithCurrentPage() {
  if (!state.autoRuleByPage || !state.pdfDoc) {
    return;
  }
  state.activeRuleId = state.currentPageNumber % 2 === 1 ? "odd" : "even";
}

function getRangeData() {
  if (!state.pdfDoc) {
    return { valid: false, message: "等待加载 PDF" };
  }

  const start = Number.parseInt(refs.startPageInput.value, 10);
  const end = Number.parseInt(refs.endPageInput.value, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { valid: false, message: "开始页和结束页都必须是整数" };
  }
  if (start < 1 || end < 1) {
    return { valid: false, message: "页码必须从 1 开始" };
  }
  if (start > end) {
    return { valid: false, message: "开始页不能大于结束页" };
  }
  if (end > state.pageCount) {
    return { valid: false, message: `结束页不能超过总页数 ${state.pageCount}` };
  }

  const pages = [];
  for (let page = start; page <= end; page += 1) {
    pages.push(page);
  }
  return { valid: true, start, end, pages };
}

function ruleTargetPages(rule, pages) {
  return pages.filter((page) => ruleAppliesToPage(rule, page));
}

function describePageTargets(rule, pages) {
  const targets = ruleTargetPages(rule, pages);
  if (!targets.length) {
    return "当前页码范围内没有命中页";
  }
  if (targets.length <= 6) {
    return `将作用于第 ${targets.join("、")} 页`;
  }
  return `将作用于第 ${targets.slice(0, 3).join("、")} ... 共 ${targets.length} 页`;
}

function getPageMetrics() {
  if (!state.pageWidthPt || !state.pageHeightPt) {
    return "-";
  }
  return `${state.pageWidthPt.toFixed(2)} × ${state.pageHeightPt.toFixed(2)} pt`;
}

function rectCount() {
  return state.rules.reduce((count, rule) => count + rule.rects.length, 0);
}

function updateMeta() {
  refs.fileNameValue.textContent = state.fileName || "未选择";
  refs.activeRuleValue.textContent = getActiveRule()?.name || "-";
  refs.pageSizeValue.textContent = getPageMetrics();
  refs.pageCountValue.textContent = state.pageCount || "-";
  refs.currentPageValue.textContent = state.pdfDoc ? `${state.currentPageNumber}` : "-";
  refs.pageNumberInput.value = state.currentPageNumber;
  refs.pageNumberInput.max = state.pageCount || 1;
  refs.startPageInput.max = state.pageCount || 1;
  refs.endPageInput.max = state.pageCount || 1;
  refs.prevPageButton.disabled = !state.pdfDoc || state.currentPageNumber <= 1;
  refs.nextPageButton.disabled = !state.pdfDoc || state.currentPageNumber >= state.pageCount;
  const activeRule = getActiveRule();
  refs.removeLastButton.disabled = !activeRule || activeRule.rects.length === 0;
  refs.clearRuleButton.disabled = !activeRule || activeRule.rects.length === 0;
  refs.processPdfButton.disabled = !state.pdfDoc || rectCount() === 0 || !getRangeData().valid;
}

function updateRangeStatus() {
  const rangeData = getRangeData();
  if (!rangeData.valid) {
    setStatus(refs.rangeStatus, rangeData.message, state.pdfDoc ? "error" : "neutral");
    return;
  }
  const coverage = rangeData.pages.includes(state.currentPageNumber)
    ? "当前页在处理范围内"
    : "当前页不在处理范围内";
  setStatus(
    refs.rangeStatus,
    `共处理 ${rangeData.pages.length} 页，${coverage}`,
    "success"
  );
}

function updateActiveRuleHint() {
  const activeRule = getActiveRule();
  if (!activeRule) {
    refs.activeRuleHint.textContent = "当前还没有可编辑分组";
    return;
  }
  const currentPageType = state.currentPageNumber % 2 === 1 ? "单页(奇数页)" : "双页(偶数页)";
  const rangeData = getRangeData();
  const summary = rangeData.valid ? describePageTargets(activeRule, rangeData.pages) : "请先确认页码范围";
  refs.activeRuleHint.textContent =
    `当前编辑 ${activeRule.name}。当前页属于 ${currentPageType}。${summary}`;
}

function buildConfigObject() {
  const rangeData = getRangeData();
  const start = rangeData.valid ? rangeData.start : 1;
  const end = rangeData.valid ? rangeData.end : 1;

  return {
    version: 2,
    pages: `${start}-${end}`,
    page_range: {
      start,
      end,
      total_pages: state.pageCount || null,
    },
    rect_mode: "xyxy",
    unit: "pt",
    rules: state.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      apply_to: rule.applyTo,
      rects: rule.rects.map((rect) => ({
        x0: rect.x0,
        y0: rect.y0,
        x1: rect.x1,
        y1: rect.y1,
      })),
    })),
  };
}

function buildCommandPreview() {
  const inputPath = refs.pdfPathInput.value.trim() || "<your-input.pdf>";
  const outputPath = deriveMaskedPath(inputPath);
  const configPath = refs.configPathInput.value.trim() || "./mask-config.json";
  return [
    "python3 scripts/mask_pdf_region.py \\",
    `  "${inputPath}" \\`,
    `  --config "${configPath}" \\`,
    `  -o "${outputPath}" \\`,
    "  --force",
  ].join("\n");
}

function updateOutputs() {
  refs.commandPreview.value = buildCommandPreview();
  refs.jsonPreview.value = JSON.stringify(buildConfigObject(), null, 2);
}

function renderRuleTabs() {
  refs.ruleTabs.innerHTML = "";
  state.rules.forEach((rule) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `rule-tab ${rule.id === state.activeRuleId ? "active" : ""}`.trim();
    button.dataset.ruleId = rule.id;
    button.innerHTML = `
      <span class="rule-tab-label">${rule.name}</span>
      <span class="rule-tab-meta">${rule.rects.length} 个矩形</span>
    `;
    refs.ruleTabs.append(button);
  });
}

function renderSelectionLayer() {
  refs.selectionLayer.innerHTML = "";
  const activeRule = getActiveRule();
  if (!activeRule) {
    return;
  }

  const drawBox = (rect, label, className = "") => {
    const cssRect = rectToCss(rect);
    if (!cssRect) {
      return;
    }
    const box = document.createElement("div");
    box.className = `rect-box ${className}`.trim();
    box.style.left = `${cssRect.left}px`;
    box.style.top = `${cssRect.top}px`;
    box.style.width = `${cssRect.width}px`;
    box.style.height = `${cssRect.height}px`;

    const chip = document.createElement("div");
    chip.className = "rect-box-label";
    chip.textContent = label;
    box.append(chip);
    refs.selectionLayer.append(box);
  };

  activeRule.rects.forEach((rect, index) => {
    drawBox(rect, `${activeRule.name} ${index + 1}`);
  });

  if (state.draftRect) {
    drawBox(state.draftRect, "拖拽中", "draft");
  }
}

function renderRuleCollections() {
  if (!rectCount()) {
    refs.ruleCollections.className = "rule-collections empty";
    refs.ruleCollections.textContent = "还没有圈选区域";
    return;
  }

  const rangeData = getRangeData();
  refs.ruleCollections.className = "rule-collections";
  refs.ruleCollections.innerHTML = "";

  state.rules.forEach((rule) => {
    const section = document.createElement("section");
    section.className = `rule-collection ${rule.id === state.activeRuleId ? "active" : ""}`.trim();

    const listHtml = rule.rects.length
      ? rule.rects
          .map(
            (rect, index) => `
              <article class="rect-item">
                <div class="rect-item-header">
                  <h4>${rule.name} · 矩形 ${index + 1}</h4>
                  <button class="ghost rect-delete" type="button" data-action="delete-rect" data-rule-id="${rule.id}" data-rect-id="${rect.id}">删除</button>
                </div>
                <div class="rect-grid">
                  <label class="field compact">
                    <span>X0</span>
                    <input type="number" step="0.1" value="${rect.x0}" data-rule-id="${rule.id}" data-rect-id="${rect.id}" data-field="x0" />
                  </label>
                  <label class="field compact">
                    <span>Y0</span>
                    <input type="number" step="0.1" value="${rect.y0}" data-rule-id="${rule.id}" data-rect-id="${rect.id}" data-field="y0" />
                  </label>
                  <label class="field compact">
                    <span>X1</span>
                    <input type="number" step="0.1" value="${rect.x1}" data-rule-id="${rule.id}" data-rect-id="${rect.id}" data-field="x1" />
                  </label>
                  <label class="field compact">
                    <span>Y1</span>
                    <input type="number" step="0.1" value="${rect.y1}" data-rule-id="${rule.id}" data-rect-id="${rect.id}" data-field="y1" />
                  </label>
                </div>
                <p class="rect-meta">
                  宽 ${rectWidth(rect).toFixed(2)} pt / ${(rectWidth(rect) / PT_PER_MM).toFixed(2)} mm
                  <br />
                  高 ${rectHeight(rect).toFixed(2)} pt / ${(rectHeight(rect) / PT_PER_MM).toFixed(2)} mm
                </p>
              </article>
            `
          )
          .join("")
      : '<div class="rule-collection-list empty">当前分组还没有矩形</div>';

    section.innerHTML = `
      <div class="rule-collection-head">
        <div>
          <h3>${rule.name}</h3>
          <p>${rangeData.valid ? describePageTargets(rule, rangeData.pages) : "请先确认页码范围"}</p>
        </div>
        <button type="button" data-action="activate-rule" data-rule-id="${rule.id}">
          ${rule.id === state.activeRuleId ? "编辑中" : "切换编辑"}
        </button>
      </div>
      <div class="rule-collection-list ${rule.rects.length ? "" : "empty"}">
        ${listHtml}
      </div>
    `;

    refs.ruleCollections.append(section);
  });
}

function syncUi() {
  updateMeta();
  updateRangeStatus();
  updateActiveRuleHint();
  renderRuleTabs();
  renderSelectionLayer();
  renderRuleCollections();
  updateOutputs();
}

function pointFromEvent(event) {
  const bounds = refs.selectionLayer.getBoundingClientRect();
  return {
    x: clamp(event.clientX - bounds.left, 0, bounds.width),
    y: clamp(event.clientY - bounds.top, 0, bounds.height),
  };
}

function toPdfPoint(point) {
  return {
    x: round((point.x / state.viewportWidthPx) * state.pageWidthPt),
    y: round((point.y / state.viewportHeightPx) * state.pageHeightPt),
  };
}

function updateDraftRect(point) {
  const startPdf = toPdfPoint(state.dragStart);
  const currentPdf = toPdfPoint(point);
  state.draftRect = normalizeRect({
    id: "draft",
    x0: startPdf.x,
    y0: startPdf.y,
    x1: currentPdf.x,
    y1: currentPdf.y,
  });
  refs.selectionHint.textContent =
    `拖拽中：x0 ${state.draftRect.x0}, y0 ${state.draftRect.y0}, x1 ${state.draftRect.x1}, y1 ${state.draftRect.y1}`;
  renderSelectionLayer();
}

async function renderCurrentPage() {
  if (!state.pdfDoc) {
    return;
  }

  const token = ++state.renderToken;
  const pdfPage = await state.pdfDoc.getPage(state.currentPageNumber);
  const viewport = pdfPage.getViewport({ scale: state.renderScale });
  const [viewX0, viewY0, viewX1, viewY1] = pdfPage.view;
  state.pageWidthPt = viewX1 - viewX0;
  state.pageHeightPt = viewY1 - viewY0;
  state.viewportWidthPx = viewport.width;
  state.viewportHeightPx = viewport.height;

  const canvas = refs.pdfCanvas;
  const context = canvas.getContext("2d");
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  refs.selectionLayer.style.width = `${viewport.width}px`;
  refs.selectionLayer.style.height = `${viewport.height}px`;

  syncActiveRuleWithCurrentPage();
  showCanvas();
  updateMeta();
  updateRangeStatus();
  updateActiveRuleHint();

  if (token !== state.renderToken) {
    return;
  }

  await pdfPage.render({
    canvasContext: context,
    viewport,
    transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
  }).promise;

  syncUi();
}

async function openPdfDocument(bytes, useWorker) {
  return pdfjsLib.getDocument({
    data: bytes.slice(),
    disableWorker: !useWorker,
  }).promise;
}

async function loadPdfFromFile(file) {
  if (!pdfjsLib || !PDFLib) {
    throw new Error("前端依赖没有加载成功。");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let pdfDoc;
  try {
    pdfDoc = await openPdfDocument(bytes, true);
  } catch (error) {
    console.warn("PDF worker 加载失败，回退到主线程模式。", error);
    pdfDoc = await openPdfDocument(bytes, false);
  }

  state.pdfDoc = pdfDoc;
  state.sourceBytes = bytes;
  state.fileName = file.name;
  state.pageCount = pdfDoc.numPages;
  state.currentPageNumber = 1;
  state.rules = PRESET_RULES.map((rule) => ({ ...rule, rects: [] }));
  state.activeRuleId = "odd";
  state.draftRect = null;
  state.isDragging = false;
  state.dragStart = null;

  refs.startPageInput.value = "1";
  refs.endPageInput.value = String(pdfDoc.numPages);

  if (!refs.pdfPathInput.value.trim()) {
    refs.pdfPathInput.value = file.name;
  }
  if (!refs.configPathInput.dataset.userEdited) {
    refs.configPathInput.value = `./${stripPdfExtension(file.name)}-mask-config.json`;
  }

  await renderCurrentPage();
}

function addRectToActiveRule(rect) {
  if (rectWidth(rect) < 1 || rectHeight(rect) < 1) {
    refs.selectionHint.textContent = "矩形太小，已忽略。";
    return;
  }
  const activeRule = getActiveRule();
  activeRule.rects.push(normalizeRect(rect));
  refs.selectionHint.textContent = `已添加到 ${activeRule.name}。`;
  syncUi();
}

async function goToPage(pageNumber) {
  if (!state.pdfDoc) {
    return;
  }
  const nextPage = clamp(pageNumber, 1, state.pageCount);
  state.currentPageNumber = nextPage;
  await renderCurrentPage();
}

async function handleFileInput(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  refs.fileLoadStatus.textContent = "PDF 加载中...";
  refs.selectionHint.textContent = "PDF 加载中...";
  showEmptyState("PDF 加载中...");

  try {
    await loadPdfFromFile(file);
    refs.fileLoadStatus.textContent = "PDF 已加载，可以开始圈选。";
    refs.fileLoadStatus.className = "status success";
    refs.selectionHint.textContent = "PDF 已加载，可直接拖拽圈选。";
    setStatus(refs.processStatus, "尚未处理", "neutral");
  } catch (error) {
    state.pdfDoc = null;
    state.sourceBytes = null;
    state.fileName = "";
    state.pageCount = 0;
    refs.fileLoadStatus.textContent = `PDF 加载失败：${error.message}`;
    refs.fileLoadStatus.className = "status error";
    refs.selectionHint.textContent = `PDF 加载失败：${error.message}`;
    showEmptyState(`PDF 加载失败：${error.message}`);
    syncUi();
  }
}

async function downloadBlob(filename, bytes, mimeType) {
  if (desktopBridge?.saveFile) {
    const filters = mimeType === "application/pdf"
      ? [{ name: "PDF", extensions: ["pdf"] }]
      : [{ name: "JSON", extensions: ["json"] }];
    const result = await desktopBridge.saveFile({
      defaultName: filename,
      mimeType,
      filters,
      bytes,
    });
    return result;
  }

  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  return { canceled: false };
}

async function processPdfInBrowser() {
  if (!state.sourceBytes || !state.fileName) {
    setStatus(refs.processStatus, "请先选择一个 PDF。", "error");
    return;
  }

  const rangeData = getRangeData();
  if (!rangeData.valid) {
    setStatus(refs.processStatus, rangeData.message, "error");
    return;
  }

  if (!rectCount()) {
    setStatus(refs.processStatus, "请至少圈选一个矩形。", "error");
    return;
  }

  setStatus(refs.processStatus, "正在处理并生成下载文件...", "neutral");
  refs.processPdfButton.disabled = true;

  try {
    const pdfDoc = await PDFLib.PDFDocument.load(state.sourceBytes.slice());
    const white = PDFLib.rgb(1, 1, 1);

    rangeData.pages.forEach((pageNumber) => {
      const page = pdfDoc.getPage(pageNumber - 1);
      const pageHeight = page.getHeight();

      state.rules.forEach((rule) => {
        if (!ruleAppliesToPage(rule, pageNumber)) {
          return;
        }
        rule.rects.forEach((rect) => {
          page.drawRectangle({
            x: rect.x0,
            y: pageHeight - rect.y1,
            width: rectWidth(rect),
            height: rectHeight(rect),
            color: white,
            borderColor: white,
            opacity: 1,
            borderOpacity: 1,
            borderWidth: 0,
          });
        });
      });
    });

    const bytes = await pdfDoc.save();
    const outputName = `${stripPdfExtension(state.fileName)}-masked.pdf`;
    const result = await downloadBlob(outputName, bytes, "application/pdf");
    if (result?.canceled) {
      setStatus(refs.processStatus, "已取消保存处理后的 PDF。", "neutral");
    } else if (result?.filePath) {
      setStatus(refs.processStatus, `处理完成，已保存到 ${result.filePath}`, "success");
    } else {
      setStatus(refs.processStatus, `处理完成，已开始下载 ${outputName}。`, "success");
    }
  } catch (error) {
    setStatus(refs.processStatus, `处理失败：${error.message}`, "error");
  } finally {
    updateMeta();
  }
}

async function downloadConfig() {
  const jsonText = refs.jsonPreview.value;
  const fileName = basename(refs.configPathInput.value.trim(), "mask-config.json");
  const bytes = new TextEncoder().encode(jsonText);
  const result = await downloadBlob(fileName, bytes, "application/json");
  if (result?.filePath) {
    refs.selectionHint.textContent = `JSON 已保存到 ${result.filePath}`;
  } else if (result?.canceled) {
    refs.selectionHint.textContent = "已取消保存 JSON。";
  } else {
    refs.selectionHint.textContent = "JSON 已开始下载。";
  }
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    refs.selectionHint.textContent = successMessage;
  } catch {
    refs.selectionHint.textContent = "复制失败，请手动复制文本框内容。";
  }
}

refs.pdfFileInput.addEventListener("change", handleFileInput);

refs.startPageInput.addEventListener("input", () => {
  updateRangeStatus();
  updateActiveRuleHint();
  renderRuleCollections();
  updateOutputs();
  updateMeta();
});

refs.endPageInput.addEventListener("input", () => {
  updateRangeStatus();
  updateActiveRuleHint();
  renderRuleCollections();
  updateOutputs();
  updateMeta();
});

refs.autoRuleCheckbox.addEventListener("change", (event) => {
  state.autoRuleByPage = Boolean(event.target.checked);
  if (state.autoRuleByPage) {
    syncActiveRuleWithCurrentPage();
  }
  syncUi();
});

refs.ruleTabs.addEventListener("click", (event) => {
  const target = event.target.closest("[data-rule-id]");
  if (!(target instanceof HTMLElement)) {
    return;
  }
  state.activeRuleId = target.dataset.ruleId;
  state.autoRuleByPage = false;
  refs.autoRuleCheckbox.checked = false;
  refs.selectionHint.textContent = `已切换到 ${getActiveRule().name}。`;
  syncUi();
});

refs.removeLastButton.addEventListener("click", () => {
  const activeRule = getActiveRule();
  activeRule.rects.pop();
  refs.selectionHint.textContent = `已撤销 ${activeRule.name} 的上一个矩形。`;
  syncUi();
});

refs.clearRuleButton.addEventListener("click", () => {
  const activeRule = getActiveRule();
  activeRule.rects = [];
  refs.selectionHint.textContent = `已清空 ${activeRule.name}。`;
  syncUi();
});

refs.processPdfButton.addEventListener("click", processPdfInBrowser);

refs.pdfPathInput.addEventListener("input", updateOutputs);

refs.configPathInput.addEventListener("input", () => {
  refs.configPathInput.dataset.userEdited = "true";
  updateOutputs();
});

refs.copyCommandButton.addEventListener("click", async () => {
  await copyText(refs.commandPreview.value, "命令已复制。");
});

refs.downloadConfigButton.addEventListener("click", downloadConfig);

refs.copyJsonButton.addEventListener("click", async () => {
  await copyText(refs.jsonPreview.value, "JSON 已复制。");
});

refs.prevPageButton.addEventListener("click", async () => {
  await goToPage(state.currentPageNumber - 1);
});

refs.nextPageButton.addEventListener("click", async () => {
  await goToPage(state.currentPageNumber + 1);
});

refs.pageNumberInput.addEventListener("change", async (event) => {
  const requestedPage = Number.parseInt(event.target.value, 10);
  if (!Number.isInteger(requestedPage)) {
    refs.pageNumberInput.value = state.currentPageNumber;
    return;
  }
  await goToPage(requestedPage);
});

refs.zoomInput.addEventListener("input", async (event) => {
  state.renderScale = Number.parseFloat(event.target.value) || 1.2;
  await renderCurrentPage();
});

refs.selectionLayer.addEventListener("pointerdown", (event) => {
  if (!state.pdfDoc) {
    return;
  }
  state.isDragging = true;
  state.dragStart = pointFromEvent(event);
  state.draftRect = null;
  refs.selectionLayer.setPointerCapture(event.pointerId);
});

refs.selectionLayer.addEventListener("pointermove", (event) => {
  if (!state.isDragging || !state.dragStart) {
    return;
  }
  updateDraftRect(pointFromEvent(event));
});

async function finalizeDrag(event) {
  if (!state.isDragging || !state.dragStart) {
    return;
  }
  const endPoint = pointFromEvent(event);
  updateDraftRect(endPoint);
  const finalRect = state.draftRect;
  state.isDragging = false;
  state.dragStart = null;
  state.draftRect = null;
  if (finalRect) {
    addRectToActiveRule(finalRect);
  } else {
    syncUi();
  }
}

refs.selectionLayer.addEventListener("pointerup", finalizeDrag);
refs.selectionLayer.addEventListener("pointercancel", finalizeDrag);

refs.ruleCollections.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.dataset.action === "activate-rule") {
    state.activeRuleId = target.dataset.ruleId;
    state.autoRuleByPage = false;
    refs.autoRuleCheckbox.checked = false;
    refs.selectionHint.textContent = `已切换到 ${getActiveRule().name}。`;
    syncUi();
    return;
  }

  if (target.dataset.action === "delete-rect") {
    const rule = state.rules.find((item) => item.id === target.dataset.ruleId);
    if (!rule) {
      return;
    }
    rule.rects = rule.rects.filter((rect) => rect.id !== target.dataset.rectId);
    refs.selectionHint.textContent = `已删除 ${rule.name} 的一个矩形。`;
    syncUi();
  }
});

refs.ruleCollections.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  const rule = state.rules.find((item) => item.id === target.dataset.ruleId);
  if (!rule) {
    return;
  }
  const rect = rule.rects.find((item) => item.id === target.dataset.rectId);
  if (!rect) {
    return;
  }
  const field = target.dataset.field;
  const value = Number.parseFloat(target.value);
  if (!field || Number.isNaN(value)) {
    syncUi();
    return;
  }

  rect[field] = value;
  Object.assign(rect, normalizeRect(rect));
  refs.selectionHint.textContent = `已更新 ${rule.name} 的坐标。`;
  syncUi();
});

updateOutputs();
updateMeta();
updateRangeStatus();
updateActiveRuleHint();
renderRuleTabs();
renderRuleCollections();
showEmptyState("先选择一个 PDF。加载后可直接在页面上拖拽圈选。");
