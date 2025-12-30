import { 
    setSessions, 
    setCurrentSessionId, 
    setPresets, 
    setConfig, 
    setAutoPerm, 
    setAutoTemp, 
    createNewSession,
    config,
    sessions,
    currentSessionId,
    presets,
    autoPerm,
    autoTemp
} from './modules/state.js';

import { 
    renderSessionList, 
    renderChat, 
    renderTempAttachments, 
    loadSettingsToUI, 
    updatePresetSelect,
    autoPermCheck,
    autoTempCheck
} from './modules/ui.js';

import { initializeEventListeners } from './modules/events.js';

/**
 * 插件初始化逻辑：从本地存储恢复状态并渲染 UI
 */
document.addEventListener('DOMContentLoaded', async () => {
    // 获取持久化存储中的配置、会话及预设信息
    const result = await chrome.storage.local.get([
        'config', 'sessions', 'currentSessionId', 'presets', 'autoPerm', 'autoTemp'
    ]);
    
    // 初始化应用状态
    if (result.config) setConfig({ ...config, ...result.config });
    if (result.presets) setPresets(result.presets);
    setSessions(result.sessions || {});
    setCurrentSessionId(result.currentSessionId);
    
    // 设置页面上下文抓取策略（永久/临时）
    setAutoPerm(!!result.autoPerm);
    setAutoTemp(!!result.autoTemp);
    autoPermCheck.checked = autoPerm;
    autoTempCheck.checked = autoTemp;

    // 若无活跃会话则自动创建
    if (!currentSessionId || !sessions[currentSessionId]) {
        createNewSession();
    }

    // 初始 UI 渲染与事件绑定
    loadSettingsToUI();
    updatePresetSelect();
    renderSessionList();
    renderChat();
    renderTempAttachments();
    
    initializeEventListeners();

    // 配置 Marked 库的代码高亮插件
    if (typeof marked !== 'undefined') {
        marked.setOptions({
            highlight: function(code, lang) {
                if (typeof hljs !== 'undefined') {
                    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
                    return hljs.highlightAuto(code).value;
                }
                return code;
            }
        });
    }
});