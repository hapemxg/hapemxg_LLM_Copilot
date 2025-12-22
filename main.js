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

document.addEventListener('DOMContentLoaded', async () => {
    const result = await chrome.storage.local.get([
        'config', 'sessions', 'currentSessionId', 'presets', 'autoPerm', 'autoTemp'
    ]);
    
    if (result.config) setConfig({ ...config, ...result.config });
    if (result.presets) setPresets(result.presets);
    setSessions(result.sessions || {});
    setCurrentSessionId(result.currentSessionId);
    
    setAutoPerm(!!result.autoPerm);
    setAutoTemp(!!result.autoTemp);
    autoPermCheck.checked = autoPerm;
    autoTempCheck.checked = autoTemp;

    if (!currentSessionId || !sessions[currentSessionId]) {
        createNewSession();
    }

    loadSettingsToUI();
    updatePresetSelect();
    renderSessionList();
    renderChat();
    renderTempAttachments();
    
    initializeEventListeners();

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
