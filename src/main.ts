import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import "./style.css";

document.addEventListener("contextmenu", (event) => event.preventDefault());

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
  return { color: value.color ?? "#000000", transparency: clamp(transparency), minTransparency: clamp(value.minTransparency ?? 20, 0, 50) };
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
    <div class="app-shell">
      <aside class="sidebar"><div class="brand"><span class="brand-mark">◐</span><span>Desk Mask</span></div>
        <nav aria-label="主菜单">
          <button class="nav-item active" data-page="mask"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9c0-5-4-9-9-9Z"/><path d="M12 3v18a9 9 0 0 0 0-18Z"/></svg>遮罩</button>
          <button class="nav-item" data-page="settings"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 17h14M8 12h11"/><circle cx="8" cy="7" r="2"/><circle cx="16" cy="17" r="2"/><circle cx="11" cy="12" r="2"/></svg>设置</button>
          <button class="nav-item" data-page="help"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M9.7 9a2.5 2.5 0 1 1 4 2c-1.2.8-1.7 1.3-1.7 2.5"/><path d="M12 16.5h.01"/></svg>说明</button>
          <button class="nav-item" data-page="author"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>关于作者</button>
        </nav>
        <p class="sidebar-foot">DESK MASK · V1</p>
      </aside>
      <main>
        <section class="page active" data-page-content="mask"><header><div><p class="eyebrow">MASK CONTROL</p><h1>遮罩</h1></div></header>
          <section class="card control-card"><label class="switch-row"><span><strong>应用遮罩</strong><small id="mask-status">遮罩当前未启用</small></span><input id="mask-switch" class="switch" type="checkbox" /></label></section>
          <section class="card"><div class="section-title"><h2>实时预览</h2></div><div id="preview"><span>你的屏幕会呈现这样的遮罩效果</span></div>
            <label>遮罩颜色 <input id="color" type="color" /></label><label><span>透明度 <output id="opacity-label"></output></span><input id="transparency" class="wide-range" type="range" min="0" step="1" /></label></section>
          <section class="card"><div class="section-title"><h2>预设</h2><button id="save" class="text-button">保存配置</button></div><div id="presets" class="preset-list"></div></section>
        </section>
        <section class="page" data-page-content="settings"><header><div><p class="eyebrow">PREFERENCES</p><h1>设置</h1></div></header>
          <section class="card"><label><span>透明度下限 <output id="min-transparency-label"></output></span><input id="min-transparency" class="wide-range" type="range" min="0" max="50" step="1" /></label></section>
          <section class="card compact"><label class="switch-row"><span><strong>开机启动</strong><small>在系统登录后运行 Desk Mask</small></span><input id="autostart" class="switch" type="checkbox" /></label><label class="switch-row"><span><strong>启动后自动显示遮罩</strong><small>使用上次保存的颜色和透明度</small></span><input id="start-visible" class="switch" type="checkbox" /></label></section>
        </section>
        <section class="page" data-page-content="help"><header><div><p class="eyebrow">GUIDE</p><h1>说明</h1></div></header><section class="card prose"><h2>如何使用</h2><p>在“遮罩”页面选择颜色和透明度，再打开“应用遮罩”开关。确认弹窗在 10 秒内未得到处理时，遮罩会自动关闭。</p><h2>适用范围</h2><p>适用于桌面、视频和无边框全屏应用。独占全屏游戏及部分 DRM 内容可能无法被普通窗口覆盖。</p></section></section>
        <section class="page" data-page-content="author"><header><div><p class="eyebrow">ABOUT</p><h1>关于作者</h1></div></header><section class="card prose"><h2>Desk Mask</h2><p>一个专注于减少屏幕视觉刺激的跨平台桌面工具。</p><p class="hint">当前版本为本地优先设计：你的颜色、预设和启动选项仅保存在此设备上。</p></section></section>
      </main>
    </div>
    <div id="save-dialog" class="dialog-backdrop" hidden>
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <p class="eyebrow">应用确认</p><h2 id="dialog-title">保存当前设置？</h2>
        <p>遮罩已应用。请在 <strong id="countdown">10</strong> 秒内确认；超时将自动取消遮罩。</p>
        <div class="dialog-actions"><button id="keep-unsaved" class="secondary">取消</button><button id="save-and-keep" class="primary">保存</button></div>
      </section>
    </div>
    <div id="preset-dialog" class="dialog-backdrop" hidden>
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="preset-dialog-title">
        <p class="eyebrow">PRESET</p><h2 id="preset-dialog-title">保存配置</h2>
        <form id="preset-form"><label class="dialog-label" for="preset-name">配置名称<input id="preset-name" maxlength="40" placeholder="例如：夜间工作" required /></label>
          <div class="dialog-actions"><button id="cancel-preset" type="button" class="secondary">取消</button><button type="submit" class="primary">保存</button></div>
        </form>
      </section>
    </div>`;

  const color = document.querySelector<HTMLInputElement>("#color")!;
  const transparency = document.querySelector<HTMLInputElement>("#transparency")!;
  const minTransparency = document.querySelector<HTMLInputElement>("#min-transparency")!;
  const minTransparencyLabel = document.querySelector<HTMLElement>("#min-transparency-label")!;
  const preview = document.querySelector<HTMLDivElement>("#preview")!;
  const opacityLabel = document.querySelector<HTMLOutputElement>("#opacity-label")!;
  const maskSwitch = document.querySelector<HTMLInputElement>("#mask-switch")!;
  const maskStatus = document.querySelector<HTMLElement>("#mask-status")!;
  const autostart = document.querySelector<HTMLInputElement>("#autostart")!;
  const startVisible = document.querySelector<HTMLInputElement>("#start-visible")!;
  const dialog = document.querySelector<HTMLDivElement>("#save-dialog")!;
  const presetDialog = document.querySelector<HTMLDivElement>("#preset-dialog")!;
  const presetForm = document.querySelector<HTMLFormElement>("#preset-form")!;
  const presetName = document.querySelector<HTMLInputElement>("#preset-name")!;
  const countdown = document.querySelector<HTMLElement>("#countdown")!;
  let countdownTimer: number | undefined;
  let syncTimer: number | undefined;

  function renderSettings() {
    color.value = settings.color;
    settings.transparency = clamp(settings.transparency, settings.minTransparency);
    transparency.min = String(settings.minTransparency);
    transparency.max = "100";
    transparency.value = String(settings.transparency);
    transparency.style.setProperty("--range-progress", `${(settings.transparency - settings.minTransparency) / (100 - settings.minTransparency) * 100}%`);
    minTransparency.value = String(settings.minTransparency);
    minTransparency.style.setProperty("--range-progress", `${settings.minTransparency * 2}%`);
    minTransparencyLabel.textContent = `${settings.minTransparency}%`;
    opacityLabel.value = `${settings.transparency}%`;
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
    maskSwitch.checked = visible;
    maskStatus.textContent = visible ? "遮罩正在应用" : "遮罩当前未启用";
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
  maskSwitch.addEventListener("change", async () => {
    const next = maskSwitch.checked;
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
  document.querySelector("#keep-unsaved")!.addEventListener("click", () => { void cancelUnconfirmedMask(); });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) void cancelUnconfirmedMask();
  });
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((item) => item.addEventListener("click", () => {
    const page = item.dataset.page;
    document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button === item));
    document.querySelectorAll<HTMLElement>(".page").forEach((section) => section.classList.toggle("active", section.dataset.pageContent === page));
  }));
  document.querySelector("#save")!.addEventListener("click", () => {
    presetName.value = "";
    presetDialog.hidden = false;
    presetName.focus();
  });
  document.querySelector("#cancel-preset")!.addEventListener("click", () => { presetDialog.hidden = true; });
  presetDialog.addEventListener("click", (event) => { if (event.target === presetDialog) presetDialog.hidden = true; });
  presetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = presetName.value.trim();
    if (!name) return;
    presets = [...presets, { ...maskSettings(), id: crypto.randomUUID(), name }]; write(PRESETS_KEY, presets); renderPresets();
    presetDialog.hidden = true;
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
