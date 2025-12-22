// modules/events.js

import { 
    sessions, currentSessionId, isGenerating, tempContexts, autoPerm, autoTemp, presets, config,
    isAgentTabSwitch,
    isAgentModeActive,
    setEditingMessageId, setConfig, setAutoPerm, setAutoTemp, saveStorage, createNewSession, 
    updateCurrentSessionTitle, currentController, setCurrentController, setSessions, 
    setCurrentSessionId, switchSession, deleteSessionById, addMessage, removeMessageByIndex, 
    replaceMessages, clearCurrentSessionMessages, setTempContexts, removeTempContextByIndex,
    setPresets,
    clearTurnApprovals,
    setIsAgentModeActive
} from './state.js';

import { 
    renderChat, renderSessionList, settingsModal, historyPanel, userInput, sendBtn, 
    stopBtn, setChatState, addSystemMessage, updatePresetSelect, loadSettingsToUI, 
    renderTempAttachments, autoPermCheck, autoTempCheck, hideExecutionStatus
} from './ui.js';

import { callLLM } from './api.js';
import { fetchPageContent, addPermanentCard, addTemporaryChip, manualAddContext } from './context.js';
import { DOM_SNAPSHOT_SCRIPT } from './domAgent.js';
import { clearPageOverlays } from './executor.js';
import { browserTools } from './tools.js';

const WATCHDOG_SCRIPT = () => {
    if (window.hasAgentWatchdog) return;
    window.hasAgentWatchdog = true;
    const notify = () => {
        window.removeEventListener('mousedown', notify, { capture: true });
        window.removeEventListener('keydown', notify, { capture: true });
        delete window.hasAgentWatchdog;
        try { chrome.runtime.sendMessage({ type: 'USER_INTERACTION_DETECTED' }); } catch(e) {}
    };
    window.addEventListener('mousedown', notify, { capture: true, once: true });
    window.addEventListener('keydown', notify, { capture: true, once: true });
};

function stopAgentTask(reason) {
    if (!isGenerating) return;
    console.warn(`Agent stopped due to: ${reason}`);
    if (currentController) {
        currentController.abort();
        setCurrentController(null);
    }
    clearPageOverlays();
    hideExecutionStatus();
    addSystemMessage(reason);
    setIsAgentModeActive(false); 
    setChatState(false);
    saveStorage();
}

export function handleSwitchSession(id) {
    clearPageOverlays();
    switchSession(id);
    renderChat();
    if(document.body.clientWidth < 450) historyPanel.classList.add('hidden');
    renderSessionList();
}

export function handleDeleteSession(id, event) {
    event.stopPropagation();
    if (confirm("确定删除此会话吗？")) {
        deleteSessionById(id);
        renderChat();
        renderSessionList();
    }
}

export function handleRetry(index) {
    if(isGenerating) return;
    const session = sessions[currentSessionId];
    const msgs = session.messages;
    const targetMsg = msgs[index];
    
    let newMessages;

    // 策略：
    // 1. 如果重试的是【用户】或【工具结果】消息，意图是保留这条消息，让 AI 重新生成回复。
    //    操作：切片保留到当前 index (包含)，触发 handleSend。
    // 2. 如果重试的是【AI】消息，意图是重写这条回复。
    //    操作：切片保留到 index 之前 (不包含)，触发 handleSend。
    
    if (targetMsg.role === 'assistant') {
        newMessages = msgs.slice(0, index);
    } else {
        newMessages = msgs.slice(0, index + 1);
    }

    // 防止悬空的工具调用：如果切片后的最后一条消息是 Assistant 且包含 tool_calls，
    // 必须移除它以防止 API 错误（因为它需要紧接着一个 tool 消息）。
    const lastMsg = newMessages[newMessages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.tool_calls && lastMsg.tool_calls.length > 0) {
        console.warn("Detected dangling tool call after retry slice. Removing parent assistant message to prevent API error.");
        newMessages.pop();
    }

    replaceMessages(newMessages);
    
    // 强制 retry 模式，避免重复添加 User 消息
    handleSend(true);
}

export function handleDeleteMessage(index) {
    if (confirm('删除此消息？')) {
        removeMessageByIndex(index);
        renderChat();
    }
}

export function handleEditSave(index, msg, newText) {
    msg.content = newText;
    if (msg.fullContent) msg.fullContent = newText;
    setEditingMessageId(null);
    saveStorage();
    renderChat();
}

export function handleRemoveTempContext(index) {
    removeTempContextByIndex(index);
    renderTempAttachments();
}

export async function handleSend(isRetry = false) {
    if (isGenerating) return;
    clearTurnApprovals();
    
    const text = userInput.value.trim();
    if (!isRetry && !text && tempContexts.length === 0 && !autoPerm && !autoTemp) return;

    // 检查是否为 Agent 模式（启用了工具）
    const activeTools = browserTools.filter(tool => config.enabledTools?.[tool.function.name]);
    const isAgentTurn = activeTools.length > 0;
    setIsAgentModeActive(isAgentTurn);

    if (!isRetry) {
        if (autoPerm) {
            const data = await fetchPageContent();
            if (data) addPermanentCard(data);
        } 
        if (autoTemp) {
            const data = await fetchPageContent();
            if (data) addTemporaryChip(data);
        }
        let fullContent = text;
        if (tempContexts.length > 0) {
            // 使用更结构化的方式包装临时上下文
            const contextXml = tempContexts.map(c => 
                `<current_page_context>\n<title>${c.title}</title>\n<url>${c.url}</url>\n<content>${c.content}</content>\n</current_page_context>`
            ).join("\n");
            fullContent = `${contextXml}\n\n${text}`;
            setTempContexts([]);
            renderTempAttachments();
        }
        addMessage({ 
            id: 'msg-' + Date.now(),
            role: 'user', 
            content: text, 
            fullContent: fullContent 
        });
        updateCurrentSessionTitle(text);
        userInput.value = '';
    }

    addMessage({ 
        role: 'assistant', 
        content: '', 
        think: '', 
        id: "ai-" + Date.now() 
    });

    renderChat();
    
    try {
        // 如果是 Agent 模式，注入交互看门狗脚本
        if (isAgentTurn) {
            console.log("Agent turn detected. Activating interaction watchdog.");
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && !tab.url.startsWith('chrome')) {
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: WATCHDOG_SCRIPT
                });
            }
        } else {
            console.log("Standard chat turn. Watchdog is disabled.");
        }
        
        await callLLM();

    } catch(e) {
        console.error("Critical error in handleSend:", e);
        setChatState(false);
        addSystemMessage(`发生未知错误: ${e.message}`);
    } finally {
        setIsAgentModeActive(false); 
        await clearPageOverlays().catch(e => console.error("Final overlay cleanup failed:", e));
    }
}

export function initializeEventListeners() {
    const visionBtn = document.getElementById('testVisionBtn');
    if (visionBtn) {
        visionBtn.addEventListener('click', async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) return alert("无法获取当前标签页");
                if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) return addSystemMessage("⚠️ 无法在浏览器系统页面执行脚本。");
                
                addSystemMessage("🕵️ 正在扫描页面交互元素...");
                
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: DOM_SNAPSHOT_SCRIPT
                });
                
                const data = results[0]?.result;
                
                if (data && data.elements) {
                    const count = data.elements.split('\n').filter(line => line.startsWith('[ID:')).length;
                    addSystemMessage(`✅ 扫描完成！发现 ${count} 个交互元素。`);
                } else if (data && data.error) {
                    addSystemMessage(`❌ 扫描脚本内部错误: ${data.error}`);
                } else {
                    addSystemMessage(`❌ 扫描失败，未返回有效数据。`);
                }
                
            } catch (err) {
                console.error(err);
                addSystemMessage(`❌ 扫描失败: ${err.message}`);
            }
        });
    }

    const clearBtn = document.getElementById('clearMarkingsBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            await clearPageOverlays();
            addSystemMessage('🧼 页面标记已清除。');
        });
    }

    document.getElementById('newChatBtn').addEventListener('click', () => {
        if(sessions[currentSessionId]?.messages.length === 0) return;
        createNewSession(); 
        renderChat();
        renderSessionList();
    });

    document.getElementById('clearContextBtn').addEventListener('click', () => {
        if(confirm('确定清空当前屏幕的所有对话吗？(会话ID和授权将重置)')) {
            clearCurrentSessionMessages();
            renderChat();
            renderSessionList();
        }
    });

    document.getElementById('historyBtn').addEventListener('click', () => {
        renderSessionList();
        historyPanel.classList.toggle('hidden');
    });
    document.getElementById('closeHistory').addEventListener('click', () => historyPanel.classList.add('hidden'));

    sendBtn.addEventListener('click', () => handleSend());
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });
    
    stopBtn.addEventListener('click', () => stopAgentTask('🛑 已手动停止生成。'));

    document.getElementById('settingsBtn').addEventListener('click', () => settingsModal.classList.remove('hidden'));
    document.getElementById('closeSettings').addEventListener('click', () => settingsModal.classList.add('hidden'));
    
    document.getElementById('saveConfig').addEventListener('click', () => {
        const newConfig = {
            apiUrl: document.getElementById('apiUrl').value.trim(),
            apiKey: document.getElementById('apiKey').value.trim(),
            model: document.getElementById('modelName').value.trim(),
            systemPrompt: document.getElementById('systemPrompt').value.trim(),
            temperature: parseFloat(document.getElementById('temperature').value),
            top_p: parseFloat(document.getElementById('topP').value),
            customJson: document.getElementById('customJson').value.trim(),
            injectedUserContext: document.getElementById('injectedUser').value.trim(),
            injectedAssistantContext: document.getElementById('injectedAssistant').value.trim(),
            maxContextChars: parseInt(document.getElementById('maxContextChars').value, 10) || 10000,
            uiTruncateLimit: parseInt(document.getElementById('uiTruncateLimit').value, 10) || 0,
            visionApiUrl: document.getElementById('visionApiUrl').value.trim(),
            visionApiKey: document.getElementById('visionApiKey').value.trim(),
            visionModel: document.getElementById('visionModel').value.trim(),
            
            // 保存工具相关配置
            toolsPrompt: document.getElementById('toolsPrompt').value.trim(),
            enabledTools: {}, // 重置并重新填充
        };

        const toolToggles = document.querySelectorAll('#tool-toggles-container input[type="checkbox"]');
        toolToggles.forEach(checkbox => {
            newConfig.enabledTools[checkbox.dataset.toolName] = checkbox.checked;
        });

        setConfig(newConfig);
        saveStorage();
        settingsModal.classList.add('hidden');
        addSystemMessage('✅ 配置已更新');
    });

    document.getElementById('savePresetBtn').addEventListener('click', () => {
        const name = prompt("给当前配置起个名字:");
        if(name) {
            const currentSettings = {
                name: name,
                apiUrl: document.getElementById('apiUrl').value,
                apiKey: document.getElementById('apiKey').value,
                model: document.getElementById('modelName').value,
                systemPrompt: document.getElementById('systemPrompt').value,
                temperature: document.getElementById('temperature').value,
                top_p: document.getElementById('topP').value,
                customJson: document.getElementById('customJson').value,
                injectedUserContext: document.getElementById('injectedUser').value,
                injectedAssistantContext: document.getElementById('injectedAssistant').value,
                maxContextChars: document.getElementById('maxContextChars').value,
                visionApiUrl: document.getElementById('visionApiUrl').value,
                visionApiKey: document.getElementById('visionApiKey').value,
                visionModel: document.getElementById('visionModel').value,

                // 保存工具配置到预设
                toolsPrompt: document.getElementById('toolsPrompt').value,
                enabledTools: {}
            };
            const toolToggles = document.querySelectorAll('#tool-toggles-container input[type="checkbox"]');
            toolToggles.forEach(checkbox => {
                currentSettings.enabledTools[checkbox.dataset.toolName] = checkbox.checked;
            });

            const idx = presets.findIndex(p => p.name === name);
            if(idx >= 0) presets[idx] = currentSettings;
            else presets.push(currentSettings);
            saveStorage();
            updatePresetSelect();
            document.getElementById('presetSelect').value = name;
        }
    });

    document.getElementById('delPresetBtn').addEventListener('click', () => {
        const name = document.getElementById('presetSelect').value;
        if(name && confirm(`确定删除预设 "${name}" 吗?`)) {
            setPresets(presets.filter(p => p.name !== name)); 
            saveStorage();
            updatePresetSelect();
        }
    });

    document.getElementById('presetSelect').addEventListener('change', (e) => {
        const name = e.target.value;
        if(!name) return;
        const p = presets.find(x => x.name === name);
        if(p) {
            document.getElementById('apiUrl').value = p.apiUrl || "";
            if(p.apiKey) document.getElementById('apiKey').value = p.apiKey;
            document.getElementById('modelName').value = p.model || "";
            document.getElementById('systemPrompt').value = p.systemPrompt || "";
            document.getElementById('temperature').value = p.temperature ?? 1.0;
            document.getElementById('topP').value = p.top_p ?? 1.0;
            document.getElementById('customJson').value = p.customJson || "";
            document.getElementById('injectedUser').value = p.injectedUserContext || "";
            document.getElementById('injectedAssistant').value = p.injectedAssistantContext || "";
            document.getElementById('maxContextChars').value = p.maxContextChars || 10000;
            document.getElementById('visionApiUrl').value = p.visionApiUrl || "";
            if(p.visionApiKey) document.getElementById('visionApiKey').value = p.visionApiKey;
            document.getElementById('visionModel').value = p.visionModel || "";

            // 加载预设中的工具配置
            document.getElementById('toolsPrompt').value = p.toolsPrompt || "";
            const toolToggles = document.querySelectorAll('#tool-toggles-container input[type="checkbox"]');
            toolToggles.forEach(checkbox => {
                const toolName = checkbox.dataset.toolName;
                checkbox.checked = !!p.enabledTools?.[toolName];
            });
        }
    });

    // 为工具管理按钮添加事件监听
    document.getElementById('enableAllToolsBtn').addEventListener('click', () => {
        const toolToggles = document.querySelectorAll('#tool-toggles-container input[type="checkbox"]');
        toolToggles.forEach(checkbox => checkbox.checked = true);
    });

    document.getElementById('disableAllToolsBtn').addEventListener('click', () => {
        const toolToggles = document.querySelectorAll('#tool-toggles-container input[type="checkbox"]');
        toolToggles.forEach(checkbox => checkbox.checked = false);
    });

    autoPermCheck.addEventListener('change', (e) => {
        setAutoPerm(e.target.checked);
        if (autoPerm) {
            setAutoTemp(false);
            autoTempCheck.checked = false;
        }
        saveStorage();
    });

    autoTempCheck.addEventListener('change', (e) => {
        setAutoTemp(e.target.checked);
        if (autoTemp) {
            setAutoPerm(false);
            autoPermCheck.checked = false;
        }
        saveStorage();
    });

    document.getElementById('addPermContextBtn')?.addEventListener('click', (e) => {
        e.preventDefault(); 
        manualAddContext('permanent');
    });

    document.getElementById('addTempContextBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        manualAddContext('temp');
    });

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'USER_INTERACTION_DETECTED') {
            stopAgentTask('⚠️ 检测到页面内操作，AI 已停止。');
        }
    });

    chrome.tabs.onActivated.addListener(() => {
        if (isAgentTabSwitch) {
            return;
        }
        
        // 仅在 Agent 模式下才因切换标签页而停止
        if (isGenerating && isAgentModeActive) {
            stopAgentTask('⚠️ 检测到您切换了标签页，AI 已停止。');
        }
    });
}