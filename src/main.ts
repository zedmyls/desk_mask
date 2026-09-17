import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import "./style.css";

type MaskSettings = { color: string; transparency: number };
type SavedSettings = MaskSettings & { minTransparency: number };
type Preset = MaskSettings & { id: string; name: string };

const SETTINGS_KEY = "desk-mask.settings";
const PRESETS_KEY = "desk-mask.presets";
const START_VISIBLE_KEY = "desk-mask.start-visible";
const isOverlay = new URLSearchParams(window.location.search).has("overlay");

const defaultPresets: Preset[] = [
  { id: "night", name: "夜间柔和", color: "#000000", transparency: 65 },
  { id: "reading", name: "暖色阅读", color: "#B15F20", transparency: 82 }
];

const read = <T>(key: string, fallback: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; }
};
const write = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const loadSettings = (): SavedSettings => {
  const value = read<Partial<SavedSettings & { opacity: number }>>(SETTINGS_KEY, {});
  const transparency = value.transparency ?? (typeof value.opacity === "number" ? 100 - value.opacity : 65);
  return { color: value.color ?? "#000000", transparency: clamp(transparency), minTransparency: clamp(value.minTransparency ?? 0) };
};
const loadPresets = (): Preset[] => read<Array<Partial<Preset & { opacity: number }>>>(PRESETS_KEY, defaultPresets)
  .map((preset, index) => ({ id: preset.id ?? crypto.randomUUID(), name: preset.name ?? `预设 ${index + 1}`, color: preset.color ?? "#000000", transparency: clamp(preset.transparency ?? (typeof preset.opacity === "number" ? 100 - preset.opacity : 65)) }));
let settings = loadSettings();
let presets = loadPresets();

function paintOverlay(next: MaskSettings) {
  document.documentElement.style.setProperty("--mask-color", next.color);
  document.documentElement.style.setProperty("--mask-opacity", String(1 - next.transparency / 100));
}

if (isOverlay) {
  document.documentElement.classList.add("overlay-window");
  document.body.innerHTML = '<div class="mask"></div>';
  paintOverlay(settings);
  // 新窗口的事件监听器可能在 Rust 第一次广播后才就绪，因此主动获取一次当前状态。
  invoke<MaskSettings>("get_mask_settings").then(paintOverlay);
  listen<MaskSettings>("mask-settings", (event) => paintOverlay(event.payload));
} else {
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <main>
      <header><div><p class="eyebrow">DESK MASK</p><h1>桌面遮罩</h1></div><button id="toggle" class="primary">应用遮罩</button></header>
      <section class="card"><div class="section-title"><h2>实时预览</h2><output id="opacity-label"></output></div>
        <div id="preview"><span>你的屏幕会呈现这样的遮罩效果</span></div>
        <label>遮罩颜色 <input id="color" type="color" /></label>
        <label>透明度 <input id="transparency" type="range" max="100" step="1" /></label>
        <label>透明度下限 <input id="min-transparency" type="range" min="0" max="100" step="1" /><small id="min-transparency-label"></small></label>
      </section>
      <section class="card"><div class="section-title"><h2>预设</h2><button id="save" class="text-button">保存当前设置</button></div><div id="presets" class="preset-list"></div></section>
      <section class="card compact"><label class="switch-row"><span><strong>登录时自动启动</strong><small>在系统登录后运行 Desk Mask</small></span><input id="autostart" type="checkbox" /></label>
        <label class="switch-row"><span><strong>启动后自动显示遮罩</strong><small>使用上次保存的颜色和强度</small></span><input id="start-visible" type="checkbox" /></label>
      </section>
      <p class="hint">遮罩不会改变显示器背光；它是一层可鼠标穿透的视觉叠加。HDR 专项适配将在后续版本进行。</p>
    </main>
    <div id="save-dialog" class="dialog-backdrop" hidden>
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <p class="eyebrow">应用确认</p><h2 id="dialog-title">保存当前设置？</h2>
        <p>遮罩已应用。请在 <strong id="countdown">10</strong> 秒内确认；超时将自动取消遮罩。</p>
        <div class="dialog-actions"><button id="keep-unsaved" class="secondary">不保存，继续</button><button id="save-and-keep" class="primary">保存并继续</button></div>
      </section>
    </div>`;

  const color = document.querySelector<HTMLInputElement>("#color")!;
  const transparency = document.querySelector<HTMLInputElement>("#transparency")!;
  const minTransparency = document.querySelector<HTMLInputElement>("#min-transparency")!;
  const minTransparencyLabel = document.querySelector<HTMLElement>("#min-transparency-label")!;
  const preview = document.querySelector<HTMLDivElement>("#preview")!;
  const opacityLabel = document.querySelector<HTMLOutputElement>("#opacity-label")!;
  const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
  const autostart = document.querySelector<HTMLInputElement>("#autostart")!;
  const startVisible = document.querySelector<HTMLInputElement>("#start-visible")!;
  const dialog = document.querySelector<HTMLDivElement>("#save-dialog")!;
  const countdown = document.querySelector<HTMLElement>("#countdown")!;
  let countdownTimer: number | undefined;
  let syncTimer: number | undefined;

  function renderSettings() {
    color.value = settings.color;
    settings.transparency = clamp(settings.transparency, settings.minTransparency);
    transparency.min = String(settings.minTransparency);
    transparency.value = String(settings.transparency);
    minTransparency.value = String(settings.minTransparency);
    minTransparencyLabel.textContent = `${settings.minTransparency}%`;
    opacityLabel.value = `透明度 ${settings.transparency}%`;
    preview.style.setProperty("--preview-color", settings.color);
    preview.style.setProperty("--preview-opacity", String(1 - settings.transparency / 100));
  }
  const maskSettings = (): MaskSettings => ({ color: settings.color, transparency: settings.transparency });
  async function syncSettings() {
    if (syncTimer) window.clearTimeout(syncTimer);
    await invoke("update_mask_settings", { settings: maskSettings() });
  }
  function queueSyncSettings() {
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => { void invoke("update_mask_settings", { settings: maskSettings() }); }, 50);
  }
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  function renderPresets() {
    document.querySelector<HTMLDivElement>("#presets")!.innerHTML = presets.map((preset) => `
      <article class="preset"><button data-apply="${preset.id}"><i style="background:${escapeHtml(preset.color)};opacity:${1 - preset.transparency / 100}"></i><span>${escapeHtml(preset.name)}<small>${escapeHtml(preset.color)} · 透明度 ${preset.transparency}%</small></span></button><button class="delete" data-delete="${preset.id}" aria-label="删除 ${escapeHtml(preset.name)}">×</button></article>`).join("");
  }
  async function refreshVisibility() {
    const visible = await invoke<boolean>("is_mask_visible");
    toggle.textContent = visible ? "取消遮罩" : "应用遮罩";
    toggle.dataset.visible = String(visible);
  }
  function closeDialog() {
    if (countdownTimer) window.clearInterval(countdownTimer);
    countdownTimer = undefined;
    dialog.hidden = true;
  }
  async function cancelUnconfirmedMask() {
    closeDialog();
    await invoke("set_mask_visible", { visible: false });
    await refreshVisibility();
  }
  function openSaveDialog() {
    closeDialog();
    let seconds = 10;
    countdown.textContent = String(seconds);
    dialog.hidden = false;
    countdownTimer = window.setInterval(() => {
      seconds -= 1;
      countdown.textContent = String(seconds);
      if (seconds <= 0) void cancelUnconfirmedMask();
    }, 1000);
  }

  color.addEventListener("input", () => { settings.color = color.value; queueSyncSettings(); renderSettings(); });
  transparency.addEventListener("input", () => { settings.transparency = Number(transparency.value); queueSyncSettings(); renderSettings(); });
  minTransparency.addEventListener("input", () => { settings.minTransparency = Number(minTransparency.value); queueSyncSettings(); renderSettings(); });
  toggle.addEventListener("click", async () => {
    const next = toggle.dataset.visible !== "true";
    if (!next) closeDialog();
    await syncSettings();
    await invoke("set_mask_visible", { visible: next });
    await refreshVisibility();
    if (next) openSaveDialog();
  });
  document.querySelector("#save-and-keep")!.addEventListener("click", () => {
    write(SETTINGS_KEY, settings);
    closeDialog();
  });
  document.querySelector("#keep-unsaved")!.addEventListener("click", closeDialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) void cancelUnconfirmedMask();
  });
  document.querySelector("#save")!.addEventListener("click", () => {
    const name = window.prompt("为此预设命名：", "我的遮罩")?.trim();
    if (!name) return;
    presets = [...presets, { ...maskSettings(), id: crypto.randomUUID(), name }]; write(PRESETS_KEY, presets); renderPresets();
  });
  document.querySelector("#presets")!.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const apply = target.closest<HTMLElement>("[data-apply]")?.dataset.apply;
    const remove = target.closest<HTMLElement>("[data-delete]")?.dataset.delete;
    if (apply) { const preset = presets.find((item) => item.id === apply); if (preset) { settings = { ...settings, color: preset.color, transparency: Math.max(preset.transparency, settings.minTransparency) }; await syncSettings(); renderSettings(); } }
    if (remove) { presets = presets.filter((item) => item.id !== remove); write(PRESETS_KEY, presets); renderPresets(); }
  });
  autostart.addEventListener("change", async () => { if (autostart.checked) await enable(); else await disable(); });
  startVisible.checked = read<boolean>(START_VISIBLE_KEY, false);
  startVisible.addEventListener("change", () => write(START_VISIBLE_KEY, startVisible.checked));
  Promise.all([isEnabled(), refreshVisibility()]).then(async ([enabled]) => {
    autostart.checked = enabled;
    if (startVisible.checked) {
      await invoke("set_mask_visible", { visible: true });
      await refreshVisibility();
    }
  });
  // 处理外接显示器连接、断开或分辨率/排列变化；隐藏遮罩时原生层会快速返回。
  window.setInterval(() => { void invoke("refresh_overlays"); }, 3000);
  renderSettings(); renderPresets();
}
